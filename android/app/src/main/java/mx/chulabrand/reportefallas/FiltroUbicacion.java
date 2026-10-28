package mx.chulabrand.reportefallas;

/**
 * Decide si una lectura de ubicación se guarda en el recorrido (oct-2026).
 *
 * Carlos vio "731.86 km" en 2 h 34 min de movimiento: el servicio pedía
 * ubicación al GPS y, de respaldo, a la "red" (antenas/WiFi), y guardaba
 * todas sin ver su precisión. Las de red caen a decenas o cientos de
 * metros, así que el recorrido brincaba ida y vuelta e inflaba km y
 * pasadas. Ahora:
 *  - se descarta cualquier lectura con precisión peor que PRECISION_MAX_METROS;
 *  - se descarta una lectura de red si hubo una de GPS hace menos de
 *    GPS_RECIENTE_MS (el GPS manda; la red solo sirve si no hay GPS).
 * Sin clases de Android a propósito, para poder probarla con Java normal.
 */
public final class FiltroUbicacion {
    public static final float PRECISION_MAX_METROS = 30f;
    public static final long GPS_RECIENTE_MS = 30000L;

    private FiltroUbicacion() {}

    /** Latido (oct-2026): si el tractor está parado no llegan lecturas
     *  (no se movió 2 m) y el Panel no distinguía "parado" de "el celular
     *  dejó de mandar". Cada LATIDO_MS sin punto se guarda uno con la
     *  posición actual, aunque no se haya movido. */
    public static final long LATIDO_MS = 5 * 60 * 1000L;
    /** La lectura para el latido debe ser reciente (si el GPS no da una
     *  posición nueva, mejor no mandar nada: eso es "sin datos"). */
    public static final long LATIDO_LECTURA_MAX_EDAD_MS = 2 * 60 * 1000L;

    public static boolean tocaLatido(long ahoraMs, long ultimoPuntoMs) {
        return ultimoPuntoMs > 0 && ahoraMs - ultimoPuntoMs >= LATIDO_MS;
    }

    public static boolean lecturaSirveParaLatido(long ahoraMs, long horaLecturaMs) {
        return horaLecturaMs > 0 && ahoraMs - horaLecturaMs <= LATIDO_LECTURA_MAX_EDAD_MS && horaLecturaMs <= ahoraMs + 60000L;
    }

    public static boolean aceptar(String proveedor, boolean tienePrecision, float precisionMetros,
                                  long ahoraMs, long ultimoGpsMs) {
        if (tienePrecision && precisionMetros > PRECISION_MAX_METROS) return false;
        boolean esGps = "gps".equals(proveedor);
        if (!esGps && ultimoGpsMs > 0 && ahoraMs - ultimoGpsMs < GPS_RECIENTE_MS) return false;
        return true;
    }
}
