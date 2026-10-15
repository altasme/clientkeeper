// Client-side PDF generator for a Bill of Service, built from scratch with
// pdf-lib (no pre-rendered base template to overlay, unlike the marketing
// site's WSA agreements -- a Bill of Service is a short, simple document,
// so drawing it directly is simpler than maintaining a separate base PDF).
// Mirrors the public bill page's own layout (altasme/clienthub's
// BillPage.tsx): No/Date/Terms, From/To, Service Scope, Line Items, Total,
// Notes -- plus the GCash payment instructions that page now shows in
// place of the old automated "Make a Payment Now" button (2026-10-15),
// since this PDF is meant to stand on its own if printed or emailed.

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { BillDetail } from "./api";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const NAVY = rgb(0.008, 0.145, 0.435);
const BLUE = rgb(0.051, 0.408, 0.937);
const INK = rgb(0.04, 0.06, 0.11);
const GRAY = rgb(0.55, 0.57, 0.62);
const LINE = rgb(0.85, 0.87, 0.91);
const PAPER_ALT = rgb(0.965, 0.973, 0.988);

const ALTAVENTURES_TIN = "717-659--00000";
const GCASH_NUMBER = "0921 283 6683";
const GCASH_ACCOUNT_NAME = "Van Da Vinci Amaranto";

function sanitizeForPdf(text: string): string {
  // Standard 14 PDF fonts use WinAnsi encoding, which has no Peso sign.
  return text.replace(/₱/g, "PHP ");
}

function formatMoney(amount: number): string {
  return `₱${new Intl.NumberFormat("en-US").format(amount)}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function wrapText(rawText: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = sanitizeForPdf(rawText);
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export async function generateBillPdf(bill: BillDetail): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let logoImage: Awaited<ReturnType<typeof pdf.embedPng>> | null = null;
  try {
    const logoBytes = await fetch("/images/brand/altaventures-logo.png").then((r) => r.arrayBuffer());
    logoImage = await pdf.embedPng(logoBytes);
  } catch {
    // Logo is a nice-to-have -- a fetch failure shouldn't block the PDF itself
  }

  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - 54;

  function text(str: string, x: number, size: number, font: PDFFont, color = INK, yOverride?: number) {
    page.drawText(sanitizeForPdf(str), { x, y: yOverride ?? y, size, font, color });
  }

  function hr(color = LINE, thickness = 1) {
    page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness, color });
  }

  if (logoImage) {
    const logoWidth = 150;
    const logoHeight = (logoWidth * logoImage.height) / logoImage.width;
    page.drawImage(logoImage, { x: MARGIN_X, y: y - logoHeight + 10, width: logoWidth, height: logoHeight });
    y -= logoHeight + 6;
  }

  y -= 20;
  text("Bill of Service", MARGIN_X, 22, fontBold, NAVY);
  y -= 22;
  text(`No: ${bill.billNumber}`, MARGIN_X, 10, fontRegular, GRAY);
  text(`Date: ${formatDate(bill.issueDate)}`, MARGIN_X + 160, 10, fontRegular, GRAY);
  text(`Valid until: ${formatDate(bill.expiresAt)}`, MARGIN_X + 320, 10, fontRegular, GRAY);
  y -= 10;
  text(bill.status === "paid" ? "PAID" : bill.status.toUpperCase(), PAGE_WIDTH - MARGIN_X - 60, 10, fontBold, bill.status === "paid" ? rgb(0.05, 0.5, 0.2) : GRAY);

  y -= 16;
  hr();
  y -= 20;

  const colWidth = CONTENT_WIDTH / 2 - 10;
  const rightColX = MARGIN_X + colWidth + 20;
  const toLines: string[] = [];
  if (bill.clientType === "corporate" && bill.recipientContactPerson) toLines.push(`Attn: ${bill.recipientContactPerson}`);
  if (bill.clientType === "corporate" && bill.recipientTin) toLines.push(`TIN: ${bill.recipientTin}`);

  text("FROM", MARGIN_X, 9, fontBold, GRAY);
  text("TO", rightColX, 9, fontBold, GRAY);
  y -= 14;
  text("Altaventures", MARGIN_X, 11, fontBold, NAVY);
  text(bill.recipientName, rightColX, 11, fontBold, NAVY);
  y -= 13;
  text(`TIN: ${ALTAVENTURES_TIN}`, MARGIN_X, 9, fontRegular, GRAY);
  let rowY = y;
  for (const line of toLines) {
    text(line, rightColX, 9, fontRegular, GRAY, rowY);
    rowY -= 11;
  }
  y = Math.min(y, rowY);

  y -= 24;
  hr();
  y -= 20;

  if (bill.scopeDescription) {
    text("SERVICE SCOPE AND DESCRIPTION", MARGIN_X, 9, fontBold, GRAY);
    y -= 14;
    for (const line of wrapText(bill.scopeDescription, fontRegular, 10, CONTENT_WIDTH)) {
      text(line, MARGIN_X, 10, fontRegular, INK);
      y -= 14;
    }
    y -= 8;
  }

  // Line items table
  page.drawRectangle({ x: MARGIN_X, y: y - 4, width: CONTENT_WIDTH, height: 18, color: PAPER_ALT });
  text("DESCRIPTION", MARGIN_X + 6, 9, fontBold, GRAY);
  text("AMOUNT", PAGE_WIDTH - MARGIN_X - 70, 9, fontBold, GRAY);
  y -= 22;

  for (const item of bill.lineItems) {
    const lines = wrapText(item.description, fontRegular, 10, CONTENT_WIDTH - 110);
    for (const [i, line] of lines.entries()) {
      text(line, MARGIN_X + 6, 10, fontRegular, INK);
      if (i === 0) text(formatMoney(item.amount), PAGE_WIDTH - MARGIN_X - 70, 10, fontBold, NAVY);
      y -= 14;
    }
    y -= 4;
  }

  y -= 4;
  hr(NAVY, 1.5);
  y -= 18;
  text("Total Amount Payable", MARGIN_X, 11, fontBold, NAVY);
  text(formatMoney(bill.totalAmount), PAGE_WIDTH - MARGIN_X - 90, 15, fontBold, NAVY);

  y -= 28;
  if (bill.notes) {
    page.drawRectangle({ x: MARGIN_X, y: y - 30, width: CONTENT_WIDTH, height: 34, color: PAPER_ALT });
    y -= 6;
    for (const line of wrapText(bill.notes, fontRegular, 9, CONTENT_WIDTH - 12)) {
      text(line, MARGIN_X + 6, 9, fontRegular, GRAY);
      y -= 12;
    }
    y -= 10;
  }

  // Payment method panel -- the GCash details that replaced the old
  // automated ganap.net checkout button on the public page (this PDF has
  // no "button" at all, so these are printed plainly instead).
  if (bill.status !== "paid" && bill.status !== "cancelled") {
    y -= 10;
    page.drawRectangle({ x: MARGIN_X, y: y - 66, width: CONTENT_WIDTH, height: 70, borderColor: LINE, borderWidth: 1 });
    y -= 14;
    text("PAYMENT METHOD", MARGIN_X + 10, 9, fontBold, GRAY);
    y -= 16;
    text("GCash Number:", MARGIN_X + 10, 11, fontRegular, INK);
    text(GCASH_NUMBER, MARGIN_X + 130, 11, fontBold, BLUE);
    y -= 18;
    text("Account Name:", MARGIN_X + 10, 11, fontRegular, INK);
    text(GCASH_ACCOUNT_NAME, MARGIN_X + 130, 11, fontBold, NAVY);
    y -= 22;
    text("Please message us once payment is sent so we can confirm and update this bill.", MARGIN_X + 10, 9, fontRegular, GRAY);
    y -= 10;
  }

  // Footer
  y = 50;
  text("Issued by Altaventures Business Development Services.", MARGIN_X, 8, fontRegular, GRAY);
  text(`Generated ${new Date().toLocaleString()}`, PAGE_WIDTH - MARGIN_X - 150, 8, fontRegular, GRAY);

  return pdf.save();
}

export function downloadBillPdf(bytes: Uint8Array, billNumber: string) {
  const blob = new Blob([bytes.slice().buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${billNumber}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
