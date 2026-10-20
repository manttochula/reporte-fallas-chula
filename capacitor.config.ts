import type { CapacitorConfig } from '@capacitor/cli';

// Esta app nativa TRAE ADENTRO la pantalla del celular (www/index.html,
// que arma server/scripts/prepararAppAndroid.js a partir de
// public/Index.html cada vez que GitHub compila el APK). Antes la cargaba
// en vivo desde Render (server.url), y con señal débil Android mostraba
// "Página web no disponible -- net::ERR_TIMED_OUT" al abrir (oct-2026).
// Ahora abre al instante; los datos se piden a Render
// (window.APP_SERVIDOR). Cuando el sitio tiene una versión más nueva de
// la pantalla, la app avisa que hay un APK nuevo. Lo nativo extra sigue
// siendo el plugin de rastreo en segundo plano
// (android/.../BackgroundLocationPlugin.kt) para "Avance Huerta".
const config: CapacitorConfig = {
  appId: 'mx.chulabrand.reportefallas',
  appName: 'Reporte de Fallas',
  webDir: 'www',
  server: {
    // Para poder abrir fotos/enlaces de esos dominios (Render, fuentes de
    // Google, S3 si la nube de archivos está activa) sin salir de la app.
    allowNavigation: [
      'reporte-fallas-chula.onrender.com',
      '*.onrender.com',
      'fonts.googleapis.com',
      'fonts.gstatic.com',
      '*.amazonaws.com',
    ],
    androidScheme: 'https',
  },
};

export default config;
