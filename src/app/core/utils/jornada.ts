/**
 * Jornada del bar: abre a las 7pm y cierra hacia las 3am, así que una noche
 * cruza la medianoche. Para que cuente como UN solo día, la jornada empieza a
 * las JORNADA_CUTOFF_HOUR (hora local) y dura 24 horas: una venta del sábado a
 * la 1:00 a.m. pertenece a la jornada del VIERNES.
 *
 * La misma hora está en Supabase (supabase/sql/fix-13-jornada.sql,
 * private.jornada_start / jornada_of). Si se cambia, cambiar en los dos lados.
 */
export const JORNADA_CUTOFF_HOUR = 12;

/** Fecha (00:00 local) de la jornada a la que pertenece `date`. */
export function jornadaOf(date: Date | string): Date {
  const d = new Date(date);
  const shifted = new Date(d.getTime() - JORNADA_CUTOFF_HOUR * 60 * 60 * 1000);
  return new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate());
}

/** Momento real en que empieza la jornada de la fecha `day` (00:00 local). */
export function jornadaStartOf(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), JORNADA_CUTOFF_HOUR);
}

/** Momento real en que empezó la jornada actual. */
export function currentJornadaStart(): Date {
  return jornadaStartOf(jornadaOf(new Date()));
}

/** true si `date` pertenece a la jornada actual. */
export function isCurrentJornada(date: Date | string): boolean {
  return jornadaOf(date).getTime() === jornadaOf(new Date()).getTime();
}
