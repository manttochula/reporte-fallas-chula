package mx.chulabrand.reportefallas;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

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

    @PluginMethod
    public void start(PluginCall call) {
        Integer avanceId = call.getInt("avanceId");
        String apiBase = call.getString("apiBase");
        if (avanceId == null || avanceId <= 0) {
            call.reject("Falta avanceId.");
            return;
        }
        if (apiBase == null || apiBase.isEmpty()) {
            call.reject("Falta apiBase.");
            return;
        }
        if (getPermissionState("location") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Falta el permiso de ubicación.");
            return;
        }

        BackgroundLocationService.establecerListener(this);

        Intent intent = new Intent(getContext(), BackgroundLocationService.class);
        intent.putExtra(BackgroundLocationService.EXTRA_AVANCE_ID, (long) avanceId.intValue());
        intent.putExtra(BackgroundLocationService.EXTRA_API_BASE, apiBase);
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

    // --- BackgroundLocationService.Listener -------------------------------
    // Reenvía cada punto nuevo a JavaScript (si la página está activa en
    // este momento -- si la pantalla está bloqueada, esto simplemente no
    // llega a ningún lado, y no afecta en nada el envío al servidor, que
    // ya se hizo por HTTP directo desde el propio servicio). Así,
    // mientras el operador SÍ está viendo la pantalla, Index.html puede
    // seguir dibujando el trazo en vivo igual que antes, en lugar de
    // perder esa parte por pasar el GPS a este plugin nativo.
    @Override
    public void onNuevoPunto(double lat, double lng) {
        JSObject data = new JSObject();
        data.put("lat", lat);
        data.put("lng", lng);
        notifyListeners("puntoNuevo", data);
    }

    @Override
    protected void handleOnDestroy() {
        BackgroundLocationService.establecerListener(null);
        super.handleOnDestroy();
    }
}
