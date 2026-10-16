package mx.chulabrand.reportefallas;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // El plugin de rastreo en segundo plano (ver BackgroundLocationPlugin)
        // es un plugin LOCAL de este proyecto, no uno instalado por npm, así
        // que hay que registrarlo a mano y ANTES de super.onCreate() -- es el
        // momento donde Capacitor arma el puente hacia JavaScript.
        registerPlugin(BackgroundLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
