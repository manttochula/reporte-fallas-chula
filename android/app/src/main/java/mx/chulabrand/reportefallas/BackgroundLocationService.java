package mx.chulabrand.reportefallas;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Servicio en primer plano que mantiene capturando el GPS del "Avance
 * Huerta" aunque el operador bloquee la pantalla del celular -- a
 * diferencia de todo lo que corre dentro del WebView (la página normal),
 * Android SÍ deja seguir vivo a un servicio en primer plano con su
 * notificación fija, que es justo la pieza que faltaba para que esto
 * funcionara con la pantalla bloqueada (petición original de Carlos).
 *
 * Es el ÚNICO lugar que escucha el GPS mientras la app nativa tiene un
 * avance activo (ver BackgroundLocationPlugin.java) -- manda cada punto
 * directo por HTTP al mismo endpoint que ya usaba el sitio web
 * (POST /api/agregarPuntoAvance, con el mismo formato {"args":[...]} del
 * shim de google.script.run en Index.html), y además avisa al plugin
 * (BackgroundLocationService.Listener) para que, si la pantalla NO está
 * bloqueada, la página siga dibujando el trazo en vivo igual que antes.
 * Si falla el envío (sin señal, por ejemplo) simplemente se descarta ese
 * punto -- el mismo comportamiento que ya tenía la versión web para estos
 * puntos de GPS (no hay cola de reintento para esto, a diferencia de los
 * reportes/diesel/movimientos).
 */
public class BackgroundLocationService extends Service implements LocationListener {

    private static final String TAG = "AvanceRastreoFondo";
    private static final String CANAL_ID = "avance_huerta_rastreo";
    private static final int NOTIF_ID = 4821;

    public static final String EXTRA_AVANCE_ID = "avanceId";
    public static final String EXTRA_API_BASE = "apiBase";

    /** Distancia mínima entre puntos para pedir uno nuevo -- mismo criterio
     *  que AVANCE_DISTANCIA_MINIMA_METROS en Index.html, para no generar
     *  de más mientras el operador está parado en un mismo lugar. */
    private static final float DISTANCIA_MINIMA_METROS = 3f;
    private static final long INTERVALO_MINIMO_MS = 4000L;

    /** Puente hacia BackgroundLocationPlugin, para que la página siga
     *  viendo los puntos en vivo cuando la pantalla NO está bloqueada
     *  (cuando SÍ está bloqueada, esto simplemente no tiene a quién
     *  avisarle -- no afecta en nada el envío al servidor, que ya pasó
     *  por HTTP directo desde este mismo servicio). */
    public interface Listener {
        void onNuevoPunto(double lat, double lng);
    }

    private static Listener listenerActivo;

    public static void establecerListener(Listener listener) {
        listenerActivo = listener;
    }

    private long avanceId;
    private String apiBase;
    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private ExecutorService envioEjecutor;

    @Override
    public void onCreate() {
        super.onCreate();
        envioEjecutor = Executors.newSingleThreadExecutor();
        crearCanalNotificacion_();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !intent.hasExtra(EXTRA_AVANCE_ID)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        this.avanceId = intent.getLongExtra(EXTRA_AVANCE_ID, 0);
        this.apiBase = intent.getStringExtra(EXTRA_API_BASE);

        startForeground(NOTIF_ID, construirNotificacion_());
        iniciarCapturaGps_();

        // START_STICKY: si Android llegara a matar este proceso por
        // memoria extrema (muy raro para un servicio en primer plano con
        // notificación visible), que intente reiniciarlo solo -- aunque
        // sin el intent original perderíamos el avanceId, así que en la
        // práctica lo que realmente recupera esa sesión es
        // avanceReanudarSiHayAbierto_ del lado del sitio en cuanto el
        // operador vuelva a abrir la app.
        return START_STICKY;
    }

    private void iniciarCapturaGps_() {
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (locationManager == null) return;
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, INTERVALO_MINIMO_MS, DISTANCIA_MINIMA_METROS, this);
            }
            // De respaldo, por si el GPS puro tarda en obtener señal o el
            // celular no lo tiene habilitado -- misma idea que el
            // enableHighAccuracy:true del lado web, pero con un proveedor
            // de reserva en vez de dejar al operador sin ningún punto.
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, INTERVALO_MINIMO_MS, DISTANCIA_MINIMA_METROS, this);
            }
        } catch (SecurityException se) {
            Log.w(TAG, "Sin permiso de ubicación al iniciar el servicio -- no debería pasar, el plugin ya lo valida antes de arrancar este servicio.", se);
            stopSelf();
            return;
        }

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReporteDeFallas:AvanceRastreoFondo");
            wakeLock.acquire(12 * 60 * 60 * 1000L /* 12h máximo, por seguridad -- nunca debería durar tanto una sola faena */);
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        final double lat = location.getLatitude();
        final double lng = location.getLongitude();
        if (listenerActivo != null) {
            listenerActivo.onNuevoPunto(lat, lng);
        }
        envioEjecutor.execute(() -> enviarPuntoAlServidor_(lat, lng));
    }

    // Métodos viejos de la interfaz LocationListener que ya no se usan
    // desde Android reciente, pero hay que implementarlos igual.
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override
    public void onProviderEnabled(String provider) {}
    @Override
    public void onProviderDisabled(String provider) {}

    private void enviarPuntoAlServidor_(double lat, double lng) {
        if (apiBase == null || apiBase.isEmpty() || avanceId <= 0) return;
        try {
            URL url = new URL(apiBase + "/api/agregarPuntoAvance");
            HttpURLConnection con = (HttpURLConnection) url.openConnection();
            con.setRequestMethod("POST");
            con.setRequestProperty("Content-Type", "application/json");
            con.setConnectTimeout(15000);
            con.setReadTimeout(15000);
            con.setDoOutput(true);
            String cuerpo = String.format(Locale.US, "{\"args\":[%d,%s,%s]}", avanceId, String.valueOf(lat), String.valueOf(lng));
            try (OutputStream os = con.getOutputStream()) {
                os.write(cuerpo.getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "agregarPuntoAvance respondió " + code + " -- se descarta este punto (mismo criterio que el sitio web sin conexión).");
            }
            con.disconnect();
        } catch (Exception e) {
            // Sin señal, timeout, etc. -- se descarta este punto nada más,
            // igual que ya hacía el sitio web antes de esta app nativa.
            Log.w(TAG, "No se pudo enviar un punto de avance (sin red probablemente): " + e.getMessage());
        }
    }

    private Notification construirNotificacion_() {
        Intent intentAbrir = new Intent(this, MainActivity.class);
        intentAbrir.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intentAbrir, flags);

        return new NotificationCompat.Builder(this, CANAL_ID)
            .setContentTitle("Registrando avance de huerta")
            .setContentText("Reporte de Fallas está capturando tu recorrido GPS. Toca para abrir.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void crearCanalNotificacion_() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CANAL_ID) == null) {
                NotificationChannel canal = new NotificationChannel(
                    CANAL_ID,
                    "Avance de huerta (GPS)",
                    NotificationManager.IMPORTANCE_LOW
                );
                canal.setDescription("Avisa mientras se está registrando tu recorrido de avance para que el sistema operativo no interrumpa el GPS.");
                nm.createNotificationChannel(canal);
            }
        }
    }

    @Override
    public void onDestroy() {
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (SecurityException ignored) {}
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        if (envioEjecutor != null) {
            envioEjecutor.shutdown();
        }
        listenerActivo = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // No se usa bind, solo startForegroundService/stopService.
    }
}
