package mx.chulabrand.reportefallas;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.List;

/**
 * Puente entre Index.html y BackgroundLocationService -- expone a JavaScript
 * (window.Capacitor.Plugins.BackgroundLocation) lo necesario para que el
 * avance de huerta siga capturando GPS con la pantalla bloqueada en
 * Android. Petición original de Carlos: "Quiero que el operador pueda
 * Iniciar avance y cerrar la aplicacion y bloquear el cel y que siga
 * capturando el avance".
 *
 * 3 permisos declarados como "alias" -- Android EXIGE pedirlos en 2 pasos
 * separados (primero "location", y SOLO si ese ya quedó concedido, aparte
 * "backgroundLocation"; pedirlos juntos hace que el sistema rechace la
 * parte de fondo en muchos celulares) -- por eso Index.html los pide uno
 * por uno, no con un solo requestPermissions() de todos. checkPermissions()
 * y requestPermissions() mismos no se tienen que escribir aquí: ya los da
 * gratis la clase Plugin de Capacitor a partir de estos alias declarados.
 */
@CapacitorPlugin(
    name = "BackgroundLocation",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location"),
        @Permission(strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, alias = "backgroundLocation"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"),
    }
)
public class BackgroundLocationPlugin extends Plugin implements BackgroundLocationService.Listener {

    /** Arranca el GPS en segundo plano para el recorrido idLocal (creado en
     *  el celular; no necesita señal). "sesion" son los datos del recorrido
     *  en JSON (huerta, nombre, actividad, equipo...) que el servicio manda
     *  al servidor junto con los puntos. */
    @PluginMethod
    public void start(PluginCall call) {
        String idLocal = call.getString("idLocal");
        String apiBase = call.getString("apiBase");
        String sesion = call.getString("sesion");
        if (!AlmacenAvance.idValido(idLocal)) {
            call.reject("Falta idLocal.");
            return;
        }
        if (apiBase == null || apiBase.isEmpty()) {
            call.reject("Falta apiBase.");
            return;
        }
        if (sesion == null || sesion.isEmpty()) {
            call.reject("Faltan los datos del recorrido.");
            return;
        }
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Falta el permiso de ubicación.");
            return;
        }

        BackgroundLocationService.establecerListener(this);

        Intent intent = new Intent(getContext(), BackgroundLocationService.class);
        intent.putExtra(BackgroundLocationService.EXTRA_ID_LOCAL, idLocal);
        intent.putExtra(BackgroundLocationService.EXTRA_API_BASE, apiBase);
        intent.putExtra(BackgroundLocationService.EXTRA_SESION, sesion);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo iniciar el rastreo en segundo plano: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        BackgroundLocationService.establecerListener(null);
        Intent intent = new Intent(getContext(), BackgroundLocationService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    /** Los puntos guardados en el celular con s > desde (para que la
     *  página copie lo que se tomó con la pantalla bloqueada). */
    @PluginMethod
    public void leerPuntos(PluginCall call) {
        String idLocal = call.getString("idLocal");
        if (!AlmacenAvance.idValido(idLocal)) {
            call.reject("Falta idLocal.");
            return;
        }
        long desde = call.getData().optLong("desde", 0L);
        List<AlmacenAvance.Punto> puntos = AlmacenAvance.leerDesde(getContext(), idLocal, desde, 0);
        JSArray lista = new JSArray();
        for (AlmacenAvance.Punto p : puntos) {
            JSObject o = new JSObject();
            o.put("s", p.s);
            o.put("lat", p.lat);
            o.put("lng", p.lng);
            o.put("t", p.t);
            lista.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("puntos", lista);
        ret.put("enviadoHasta", AlmacenAvance.enviadoHasta(getContext(), idLocal));
        call.resolve(ret);
    }

    /** Borra del celular un recorrido ya enviado completo. */
    @PluginMethod
    public void borrarSesion(PluginCall call) {
        String idLocal = call.getString("idLocal");
        if (AlmacenAvance.idValido(idLocal)) AlmacenAvance.borrar(getContext(), idLocal);
        call.resolve();
    }

    @Override
    public void onNuevoPunto(String idLocal, long s, double lat, double lng, long t) {
        JSObject data = new JSObject();
        data.put("idLocal", idLocal);
        data.put("s", s);
        data.put("lat", lat);
        data.put("lng", lng);
        data.put("t", t);
        notifyListeners("puntoNuevo", data);
    }

    @Override
    protected void handleOnDestroy() {
        BackgroundLocationService.establecerListener(null);
        super.handleOnDestroy();
    }
}
