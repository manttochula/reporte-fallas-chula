import type { CapacitorConfig } from '@capacitor/cli';

// Esta app nativa NO trae el sitio empaquetado adentro -- lo carga en vivo
// desde la misma dirección donde ya vive en Render (server.url), para que
// sea EXACTAMENTE el mismo sitio de siempre (Reportar, Historial, Taller,
// Panel, Movimientos, Avance) y cualquier cambio futuro que subamos al
// sitio se vea también aquí, sin tener que volver a compilar la app. Lo
// único que agrega esta app nativa es el plugin de rastreo en segundo
// plano (ver android/.../BackgroundLocationPlugin.kt) para el GPS de
// "Avance Huerta" cuando el celular está bloqueado.
const config: CapacitorConfig = {
  appId: 'mx.chulabrand.reportefallas',
  appName: 'Reporte de Fallas',
  webDir: 'www',
  server: {
    url: 'https://reporte-fallas-chula.onrender.com',
    // Necesario porque el sitio real sirve contenido de otros orígenes
    // (fuentes de Google, S3 si la nube de archivos está activa, etc.) --
    // sin esto el WebView bloquearía la navegación a esos dominios.
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
