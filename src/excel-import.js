import XLSX from 'xlsx';

export const REQUIRED_HEADERS = ['Numero STT', 'Nr. di riferimento del Mittente'];

function clean(value) {
  return String(value ?? '').trim();
}

export function readDsvWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('Il file non contiene fogli di lavoro.');

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerIndex = matrix.findIndex((row) =>
    REQUIRED_HEADERS.every((header) => row.map(clean).includes(header)),
  );
  if (headerIndex === -1) {
    throw new Error(`Intestazioni non trovate: ${REQUIRED_HEADERS.join(', ')}.`);
  }

  const headers = matrix[headerIndex].map(clean);
  const trackingColumn = headers.indexOf('Numero STT');
  const referenceColumn = headers.indexOf('Nr. di riferimento del Mittente');
  const rows = matrix.slice(headerIndex + 1)
    .map((row, index) => ({
      sourceRow: headerIndex + index + 2,
      trackingNumber: clean(row[trackingColumn]),
      orderReference: clean(row[referenceColumn]),
    }))
    .filter((row) => row.trackingNumber || row.orderReference);

  const occurrences = new Map();
  for (const row of rows) {
    if (row.orderReference) {
      occurrences.set(row.orderReference, (occurrences.get(row.orderReference) ?? 0) + 1);
    }
  }
  return rows.map((row) => ({
    ...row,
    validation: !row.trackingNumber ? 'Tracking mancante'
      : !row.orderReference ? 'Riferimento ordine mancante'
        : occurrences.get(row.orderReference) > 1 ? 'Riferimento duplicato nel file'
          : 'Pronta per la verifica',
  }));
}
