// Centavos (integers, as MyCafe stores them) to a display string.
export const peso = (centavos: number): string =>
  `₱${(centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
