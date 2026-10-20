package mx.chulabrand.reportefallas;

import android.content.Context;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Guarda en el celular los puntos GPS del "Avance Huerta" (modo SIN SEÑAL,
 * oct-2026 -- petición de Carlos: "que funcione completamente sin señal y
 * cuando agarre datos se actualice"). Un archivo de texto por recorrido
 * (idLocal), una línea por punto: "s,lat,lng,t" (s = número consecutivo,
 * t = hora en milisegundos). Aparte, cuál fue el último punto que el
 * servidor confirmó (enviadoHasta) y el siguiente número a usar.
 *
 * Lo usan el servicio (BackgroundLocationService, que escribe y envía) y
 * el plugin (BackgroundLocationPlugin, que lo lee para la página): todos
 * los métodos son "synchronized" sobre la misma clase para que no se
 * pisen.
 */
public final class AlmacenAvance {

    private static final Pattern ID_VALIDO = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");

    public static final class Punto {
        public final long s;
        public final double lat;
        public final double lng;
        public final long t;
        Punto(long s, double lat, double lng, long t) {
            this.s = s; this.lat = lat; this.lng = lng; this.t = t;
        }
    }

    private AlmacenAvance() {}

    public static boolean idValido(String idLocal) {
        return idLocal != null && ID_VALIDO.matcher(idLocal).matches();
    }

    private static File carpeta(Context ctx) {
        File dir = new File(ctx.getFilesDir(), "avance");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }
    private static File archivoPuntos(Context ctx, String idLocal) { return new File(carpeta(ctx), idLocal + ".pts"); }
    private static File archivoEstado(Context ctx, String idLocal) { return new File(carpeta(ctx), idLocal + ".est"); }

    /** [siguiente, enviadoHasta] */
    private static long[] leerEstado(Context ctx, String idLocal) {
        long[] estado = new long[] { 1L, 0L };
        File f = archivoEstado(ctx, idLocal);
        if (!f.exists()) return estado;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
            String linea = br.readLine();
            if (linea != null) {
                String[] partes = linea.trim().split(",");
                if (partes.length >= 2) {
                    estado[0] = Math.max(1L, Long.parseLong(partes[0]));
                    estado[1] = Math.max(0L, Long.parseLong(partes[1]));
                }
            }
        } catch (Exception ignored) {
            // archivo dañado: se vuelve a calcular abajo con los puntos
        }
        return estado;
    }

    private static void escribirEstado(Context ctx, String idLocal, long siguiente, long enviadoHasta) throws Exception {
        File f = archivoEstado(ctx, idLocal);
        File tmp = new File(f.getPath() + ".tmp");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(tmp, false), StandardCharsets.UTF_8)) {
            w.write(siguiente + "," + enviadoHasta + "\n");
        }
        if (!tmp.renameTo(f)) {
            // En algunos celulares rename no reemplaza: se borra y se reintenta.
            f.delete();
            tmp.renameTo(f);
        }
    }

    /** Guarda un punto nuevo y regresa su número consecutivo (s), o -1 si no se pudo. */
    public static synchronized long agregarPunto(Context ctx, String idLocal, double lat, double lng, long t) {
        if (!idValido(idLocal)) return -1;
        try {
            long[] estado = leerEstado(ctx, idLocal);
            long s = estado[0];
            File f = archivoPuntos(ctx, idLocal);
            // Si la última línea quedó cortada (se apagó el celular a medio
            // escribir), se cierra antes para no pegarle el punto nuevo.
            boolean faltaSalto = false;
            if (f.exists() && f.length() > 0) {
                try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                    raf.seek(f.length() - 1);
                    faltaSalto = raf.read() != '\n';
                }
            }
            try (Writer w = new OutputStreamWriter(new FileOutputStream(f, true), StandardCharsets.UTF_8)) {
                if (faltaSalto) w.write("\n");
                w.write(String.format(Locale.US, "%d,%.7f,%.7f,%d\n", s, lat, lng, t));
            }
            escribirEstado(ctx, idLocal, s + 1, estado[1]);
            return s;
        } catch (Exception e) {
            return -1;
        }
    }

    /** Puntos con s > desde, en orden, máximo "limite" (0 = todos). */
    public static synchronized List<Punto> leerDesde(Context ctx, String idLocal, long desde, int limite) {
        List<Punto> lista = new ArrayList<>();
        if (!idValido(idLocal)) return lista;
        File f = archivoPuntos(ctx, idLocal);
        if (!f.exists()) return lista;
        try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
            String linea;
            while ((linea = br.readLine()) != null) {
                String[] p = linea.trim().split(",");
                if (p.length < 4) continue; // línea cortada (se apagó el celular a medio escribir)
                try {
                    long s = Long.parseLong(p[0]);
                    if (s <= desde) continue;
                    lista.add(new Punto(s, Double.parseDouble(p[1]), Double.parseDouble(p[2]), Long.parseLong(p[3])));
                    if (limite > 0 && lista.size() >= limite) break;
                } catch (NumberFormatException ignored) {
                    // línea dañada: se salta
                }
            }
        } catch (Exception ignored) {
            // si no se puede leer, se regresa lo que se alcanzó
        }
        return lista;
    }

    public static synchronized long enviadoHasta(Context ctx, String idLocal) {
        if (!idValido(idLocal)) return 0;
        return leerEstado(ctx, idLocal)[1];
    }

    public static synchronized void marcarEnviado(Context ctx, String idLocal, long hasta) {
        if (!idValido(idLocal)) return;
        try {
            long[] estado = leerEstado(ctx, idLocal);
            if (hasta > estado[1]) escribirEstado(ctx, idLocal, estado[0], hasta);
        } catch (Exception ignored) {
            // se volverá a mandar; el servidor no duplica
        }
    }

    public static synchronized void borrar(Context ctx, String idLocal) {
        if (!idValido(idLocal)) return;
        archivoPuntos(ctx, idLocal).delete();
        archivoEstado(ctx, idLocal).delete();
    }
}
