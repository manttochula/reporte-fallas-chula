package mx.chulabrand.reportefallas;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Servicio en primer plano que mantiene capturando el GPS del "Avance
 * Huerta" aunque el operador bloquee la pantalla del celular (Android SÍ
 * deja seguir vivo a un servicio en primer plano con su notificación fija).
 *
 * Modo SIN SEÑAL (oct-2026, petición de Carlos): cada punto se GUARDA
 * primero en el celular (AlmacenAvance) con su hora y un número
 * consecutivo; después se intenta mandar lo pendiente al servidor
 * (POST /api/sincronizarAvance, en tandas). Si no hay señal, no se pierde
 * nada: se reintenta con cada punto nuevo y cada minuto, y lo que quede al
 * terminar lo manda la página (Index.html, avanceSincronizarPendientes_)
 * en cuanto haya señal. El servidor no duplica puntos si un envío se
 * repite. También avisa cada punto al plugin para que, si la pantalla NO
 * está bloqueada, la página siga dibujando el trazo en vivo.
 */
public class BackgroundLocationService extends Service implements LocationListener {

    private static final String TAG = "AvanceRastreoFondo";
    private static final String CANAL_ID = "avance_huerta_rastreo";
    private static final int NOTIF_ID = 4821;

    public static final String EXTRA_ID_LOCAL = "idLocal";
    public static final String EXTRA_API_BASE = "apiBase";
    public static final String EXTRA_SESION = "sesion";

    /** Para retomar solo el recorrido si Android reinicia el servicio. */
    private static final String PREFS = "avance_activo";

    /** Distancia mínima entre puntos -- mismo criterio que
     *  AVANCE_DISTANCIA_MINIMA_METROS en Index.html. Oct-2026 (Carlos quiere
     *  trazos como los de JDLink): de 3 m / 4 s a 2 m / 2 s, para que las
     *  vueltas y los surcos salgan más parecidos a la realidad. */
    private static final float DISTANCIA_MINIMA_METROS = 2f;
    private static final long INTERVALO_MINIMO_MS = 2000L;
    private static final int PUNTOS_POR_ENVIO = 300;
    private static final long ESPERA_ENTRE_INTENTOS_MS = 15000L;

    /** Puente hacia BackgroundLocationPlugin (la página, si está abierta). */
    public interface Listener {
        void onNuevoPunto(String idLocal, long s, double lat, double lng, long t);
    }

    private static Listener listenerActivo;

    public static void establecerListener(Listener listener) {
        listenerActivo = listener;
    }

    private String idLocal;
    private String apiBase;
    private String sesionJson;
    private LocationManager locationManager;
    /** Servicio de ubicación de Google (Fused, gratis, viene con los
     *  servicios de Google Play): combina el GPS con los sensores del
     *  celular y da posiciones más estables. Si el celular no tiene
     *  servicios de Google Play, se usa el GPS normal (locationManager). */
    private FusedLocationProviderClient fusedCliente;
    private LocationCallback fusedCallback;
    private PowerManager.WakeLock wakeLock;
    private ScheduledExecutorService envioEjecutor;
    private volatile boolean enviando = false;
    private volatile long ultimoIntentoMs = 0L;
    private volatile boolean creadoEnServidor = false;
    private boolean reintentoProgramado = false;
    /** Hora de la última lectura buena del GPS (ver FiltroUbicacion). */
    private volatile long ultimoGpsMs = 0L;
    /** Hora del último punto guardado (para el latido, ver FiltroUbicacion.LATIDO_MS). */
    private volatile long ultimoPuntoMs = 0L;

    @Override
    public void onCreate() {
        super.onCreate();
        envioEjecutor = Executors.newSingleThreadScheduledExecutor();
        crearCanalNotificacion_();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String idAnterior = idLocal;
        if (intent != null && intent.hasExtra(EXTRA_ID_LOCAL)) {
            idLocal = intent.getStringExtra(EXTRA_ID_LOCAL);
            apiBase = intent.getStringExtra(EXTRA_API_BASE);
            sesionJson = intent.getStringExtra(EXTRA_SESION);
            prefs.edit().putString(EXTRA_ID_LOCAL, idLocal).putString(EXTRA_API_BASE, apiBase).putString(EXTRA_SESION, sesionJson).apply();
        } else {
            // Android reinició el servicio (START_STICKY) sin el intent
            // original: se retoma el recorrido guardado, sin perder nada.
            idLocal = prefs.getString(EXTRA_ID_LOCAL, null);
            apiBase = prefs.getString(EXTRA_API_BASE, null);
            sesionJson = prefs.getString(EXTRA_SESION, null);
        }
        if (!AlmacenAvance.idValido(idLocal)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (idAnterior != null && !idAnterior.equals(idLocal)) creadoEnServidor = false;

        startForeground(NOTIF_ID, construirNotificacion_());
        if (ultimoPuntoMs == 0L) ultimoPuntoMs = System.currentTimeMillis();
        iniciarCapturaGps_();
        // Reintento periódico: si el tractor se queda parado (sin puntos
        // nuevos) igual se manda lo pendiente cuando regrese la señal.
        if (!reintentoProgramado) {
            reintentoProgramado = true;
            envioEjecutor.scheduleWithFixedDelay(this::enviarPendientes_, 5, 60, TimeUnit.SECONDS);
            // Latido: revisa cada minuto si ya pasaron 5 min sin punto.
            envioEjecutor.scheduleWithFixedDelay(this::revisarLatido_, 60, 60, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    private boolean hayGooglePlay_() {
        try {
            return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this) == ConnectionResult.SUCCESS;
        } catch (Exception e) {
            return false;
        }
    }

    private void iniciarCapturaGps_() {
        if (locationManager != null || fusedCliente != null) return; // ya estaba capturando
        try {
            if (hayGooglePlay_()) {
                fusedCliente = LocationServices.getFusedLocationProviderClient(this);
                LocationRequest pedido = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVALO_MINIMO_MS)
                    .setMinUpdateIntervalMillis(1000L)
                    .setMinUpdateDistanceMeters(DISTANCIA_MINIMA_METROS)
                    .setWaitForAccurateLocation(true)
                    .build();
                fusedCallback = new LocationCallback() {
                    @Override
                    public void onLocationResult(LocationResult resultado) {
                        if (resultado == null) return;
                        for (Location loc : resultado.getLocations()) procesarUbicacion_(loc);
                    }
                };
                fusedCliente.requestLocationUpdates(pedido, fusedCallback, Looper.getMainLooper());
            } else {
                locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
                if (locationManager == null) return;
                if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, INTERVALO_MINIMO_MS, DISTANCIA_MINIMA_METROS, this);
                }
                // De respaldo, por si el GPS puro tarda en obtener señal (FiltroUbicacion
                // descarta estas lecturas si son imprecisas o si hay GPS reciente).
                if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, INTERVALO_MINIMO_MS, DISTANCIA_MINIMA_METROS, this);
                }
            }
        } catch (SecurityException se) {
            Log.w(TAG, "Sin permiso de ubicación al iniciar el servicio.", se);
            stopSelf();
            return;
        }

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ReporteDeFallas:AvanceRastreoFondo");
            wakeLock.acquire(12 * 60 * 60 * 1000L /* 12h máximo, por seguridad */);
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        procesarUbicacion_(location);
    }

    /** Latido: si el tractor lleva 5 min sin moverse, guarda un punto con la
     *  posición ACTUAL (lectura reciente del GPS). Si el GPS no da una
     *  lectura nueva no se guarda nada: en el Panel eso sale "sin datos". */
    private void revisarLatido_() {
        try {
            if (idLocal == null || !FiltroUbicacion.tocaLatido(System.currentTimeMillis(), ultimoPuntoMs)) return;
            if (fusedCliente != null) {
                fusedCliente.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                    .addOnSuccessListener(loc -> procesarLatido_(loc));
            } else if (locationManager != null) {
                Location loc = null;
                try { loc = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER); } catch (SecurityException ignored) { }
                procesarLatido_(loc);
            }
        } catch (Exception e) {
            Log.w(TAG, "No se pudo revisar el latido.", e);
        }
    }

    private void procesarLatido_(Location loc) {
        if (loc == null) return;
        long ahora = System.currentTimeMillis();
        if (!FiltroUbicacion.tocaLatido(ahora, ultimoPuntoMs)) return; // ya llegó un punto normal
        if (!FiltroUbicacion.lecturaSirveParaLatido(ahora, loc.getTime())) return;
        procesarUbicacion_(loc);
    }

    private void procesarUbicacion_(Location location) {
        if (location == null || idLocal == null) return;
        final long ahora = System.currentTimeMillis();
        if (!FiltroUbicacion.aceptar(location.getProvider(), location.hasAccuracy(), location.getAccuracy(), ahora, ultimoGpsMs)) {
            return; // poca precisión, o lectura de red teniendo GPS: brincaría el recorrido
        }
        if (LocationManager.GPS_PROVIDER.equals(location.getProvider())) ultimoGpsMs = ahora;
        final double lat = location.getLatitude();
        final double lng = location.getLongitude();
        final long t = System.currentTimeMillis();
        final long s = AlmacenAvance.agregarPunto(this, idLocal, lat, lng, t);
        if (s <= 0) return;
        ultimoPuntoMs = t;
        Listener l = listenerActivo;
        if (l != null) {
            l.onNuevoPunto(idLocal, s, lat, lng, t);
        }
        if (!enviando && System.currentTimeMillis() - ultimoIntentoMs >= ESPERA_ENTRE_INTENTOS_MS) {
            try { envioEjecutor.execute(this::enviarPendientes_); } catch (Exception ignored) { /* servicio terminando */ }
        }
    }

    // Métodos viejos de la interfaz LocationListener (hay que implementarlos).
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override
    public void onProviderEnabled(String provider) {}
    @Override
    public void onProviderDisabled(String provider) {}

    /** Manda al servidor lo pendiente, en tandas. Sin señal: no pasa nada, se reintenta después. */
    private void enviarPendientes_() {
        if (enviando || apiBase == null || apiBase.isEmpty() || sesionJson == null) return;
        enviando = true;
        ultimoIntentoMs = System.currentTimeMillis();
        try {
            JSONObject sesion = new JSONObject(sesionJson);
            for (int vuelta = 0; vuelta < 50; vuelta++) {
                long desde = AlmacenAvance.enviadoHasta(this, idLocal);
                List<AlmacenAvance.Punto> puntos = AlmacenAvance.leerDesde(this, idLocal, desde, PUNTOS_POR_ENVIO);
                if (puntos.isEmpty() && creadoEnServidor) break;
                JSONArray lista = new JSONArray();
                for (AlmacenAvance.Punto p : puntos) {
                    JSONObject o = new JSONObject();
                    o.put("s", p.s);
                    o.put("lat", p.lat);
                    o.put("lng", p.lng);
                    o.put("t", p.t);
                    lista.put(o);
                }
                JSONArray args = new JSONArray();
                args.put(sesion);
                args.put(lista);
                JSONObject cuerpo = new JSONObject();
                cuerpo.put("args", args);
                JSONObject respuesta = postJson_(apiBase + "/api/sincronizarAvance", cuerpo.toString());
                if (respuesta == null || !respuesta.optBoolean("success", false)) break;
                creadoEnServidor = true;
                long hasta = respuesta.optLong("ultimoSeq", 0L);
                AlmacenAvance.marcarEnviado(this, idLocal, hasta);
                if (puntos.isEmpty() || hasta < puntos.get(puntos.size() - 1).s) break;
            }
        } catch (Exception e) {
            Log.w(TAG, "No se pudo mandar el avance (sin señal probablemente): " + e.getMessage());
        } finally {
            enviando = false;
        }
    }

    private JSONObject postJson_(String direccion, String cuerpo) {
        HttpURLConnection con = null;
        try {
            URL url = new URL(direccion);
            con = (HttpURLConnection) url.openConnection();
            con.setRequestMethod("POST");
            con.setRequestProperty("Content-Type", "application/json");
            con.setConnectTimeout(15000);
            con.setReadTimeout(60000);
            con.setDoOutput(true);
            try (OutputStream os = con.getOutputStream()) {
                os.write(cuerpo.getBytes(StandardCharsets.UTF_8));
            }
            int code = con.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "sincronizarAvance respondió " + code);
                return null;
            }
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(con.getInputStream(), StandardCharsets.UTF_8))) {
                String linea;
                while ((linea = br.readLine()) != null) sb.append(linea);
            }
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            Log.w(TAG, "Sin señal al mandar el avance: " + e.getMessage());
            return null;
        } finally {
            if (con != null) con.disconnect();
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
            locationManager = null;
        }
        if (fusedCliente != null && fusedCallback != null) {
            try { fusedCliente.removeLocationUpdates(fusedCallback); } catch (Exception ignored) {}
        }
        fusedCliente = null;
        fusedCallback = null;
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        if (envioEjecutor != null) {
            envioEjecutor.shutdownNow();
        }
        // Se terminó el recorrido: ya no se retoma solo. Lo que falte por
        // mandar sigue guardado (AlmacenAvance) y lo manda la página.
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        listenerActivo = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // No se usa bind, solo startForegroundService/stopService.
    }
}
