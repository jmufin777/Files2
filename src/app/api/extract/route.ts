import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ExtractRequest = {
  filePath: string;
  fileName: string;
};

// Extrahuje text z Word, Excel, PDF, TXT souborů
export async function POST(request: Request) {
  let payload: ExtractRequest = { filePath: "", fileName: "" };
  try {
    payload = (await request.json()) as ExtractRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const { filePath, fileName } = payload;

  if (!filePath || !fileName) {
    return NextResponse.json(
      { error: "Missing filePath or fileName." },
      { status: 400 }
    );
  }

  try {
    const ext = fileName.toLowerCase().split(".").pop();

    const { existsSync } = await import("fs");
    if (!existsSync(filePath)) {
      return NextResponse.json(
        {
          error: `Soubor nebyl nalezen na serveru: ${filePath}`,
          hint: "Ujistěte se, že Samba je připojená na serveru, kde běží aplikace.",
        },
        { status: 404 }
      );
    }

    // Dynamické importy podle typu souboru
    let text = "";

    switch (ext) {
      case "docx": {
        // Word dokumenty
        const { readFileSync } = await import("fs");
        const JSZip = (await import("jszip")).default;
        const buffer = readFileSync(filePath);
        const zip = new JSZip();
        await zip.loadAsync(buffer);

        const xmlFile = zip.file("word/document.xml");
        if (!xmlFile) throw new Error("Invalid DOCX file");

        const xmlContent = await xmlFile.async("text");
        // Jednoduchý regex pro extrakci textu z XML
        text = xmlContent
          .replace(/<[^>]*>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .trim();
        break;
      }

      case "xlsx":
      case "xls": {
        // Excel soubory
        const XLSX = await import("xlsx");
        const { readFileSync } = await import("fs");
        const buffer = readFileSync(filePath);
        const workbook = XLSX.read(buffer, {
          type: "buffer",
          cellText: false,
          cellDates: true,
        });

        const textParts: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          textParts.push(`Sheet: ${sheetName}\n`);
          const csvContent = XLSX.utils.sheet_to_csv(sheet, {
            blankrows: false,
          });
          if (csvContent.trim().length > 0) {
            textParts.push(csvContent);
          }
        }
        text = textParts.join("\n");
        break;
      }

      case "pdf": {
        // PDF soubory
        if (!globalThis.DOMMatrix) {
          const domMatrixModule = await import("dommatrix");
          const DOMMatrix =
            (domMatrixModule as { DOMMatrix?: typeof globalThis.DOMMatrix })
              .DOMMatrix ??
            (domMatrixModule as { default?: typeof globalThis.DOMMatrix })
              .default;
          if (DOMMatrix) {
            globalThis.DOMMatrix = DOMMatrix;
          }
        }
        const { readFileSync } = await import("fs");
        const buffer = readFileSync(filePath);
        const dataBytes =
          buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        
        try {
          const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
            import.meta.url
          ).toString();
          const doc = await pdfjs.getDocument({
            data: new Uint8Array(dataBytes),
            disableWorker: true,
          }).promise;
          let output = "";
          for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            const page = await doc.getPage(pageNumber);
            const content = await page.getTextContent();
            const pageText = (content.items as Array<{ str?: string }>)
              .map((item) => item.str ?? "")
              .join(" ");
            output += `${pageText}\n`;
            if (output.length >= 500_000) {
              output = `${output.slice(0, 500_000)}\n\n[Truncated to 500000 chars]`;
              break;
            }
          }
          text = output;
        } catch (error) {
          throw new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
        break;
      }

      case "txt":
      case "md":
      case "csv": {
        // Textové soubory
        const { readFileSync } = await import("fs");
        text = readFileSync(filePath, "utf-8");
        break;
      }

      default: {
        return NextResponse.json(
          { error: `Unsupported file type: ${ext}` },
          { status: 400 }
        );
      }
    }

    // Vyčistit text
    const cleanedText = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .join("\n")
      .slice(0, 500_000); // Limit na 500KB per file

    return NextResponse.json({
      success: true,
      fileName,
      filePath,
      textLength: cleanedText.length,
      text: cleanedText,
      fileType: ext,
    });
  } catch (error) {
    console.error(`Extraction error for ${fileName}:`, error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Extraction failed.",
        fileName,
      },
      { status: 500 }
    );
  }
}
