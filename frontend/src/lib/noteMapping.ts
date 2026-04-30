const SCALE = ["C3", "D3", "E3", "G3", "A3", "C4", "D4", "E4", "G4", "A4"];
const MIN_LAT = 41.6;
const MAX_LAT = 42.1;

export function getNoteFromLat(lat: number): string {
  const clampedLat = Math.min(MAX_LAT, Math.max(MIN_LAT, lat));
  const normalized = (clampedLat - MIN_LAT) / (MAX_LAT - MIN_LAT);
  const index = Math.floor(normalized * (SCALE.length - 1));
  return SCALE[index];
}
