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

    public static boolean aceptar(String proveedor, boolean tienePrecision, float precisionMetros,
                                  long ahoraMs, long ultimoGpsMs) {
        if (tienePrecision && precisionMetros > PRECISION_MAX_METROS) return false;
        boolean esGps = "gps".equals(proveedor);
        if (!esGps && ultimoGpsMs > 0 && ahoraMs - ultimoGpsMs < GPS_RECIENTE_MS) return false;
        return true;
    }
}
