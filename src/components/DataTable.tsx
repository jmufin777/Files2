"use client";

import { useRef } from "react";
import * as XLSX from "xlsx";

type DataTableProps = {
  title: string;
  headers: string[];
  rows: (string | number)[][];
  id?: string;
};

export default function DataTable({ title, headers, rows, id }: DataTableProps) {
  const tableRef = useRef<HTMLTableElement>(null);

  const handleExport = () => {
    if (!tableRef.current) return;

    // Create workbook from table
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.table_to_sheet(tableRef.current);
    
    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    
    // Generate filename
    const filename = `${title.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
    
    // Download
    XLSX.writeFile(wb, filename);
  };

  if (!headers.length || !rows.length) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        </div>
        <p className="text-xs text-slate-500">Žádná data pro tabulku.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        <button
          onClick={handleExport}
          className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold transition shadow-sm"
          title="Exportovat do Excel"
        >
          📊 XLS Export
        </button>
      </div>
      
      <div className="mt-3 max-h-[500px] overflow-auto border border-slate-700 rounded-lg">
        <table ref={tableRef} className="w-full border-collapse bg-white text-slate-900">
          <thead className="sticky top-0 bg-slate-100 border-b-2 border-slate-300">
            <tr>
              {headers.map((header, idx) => (
                <th
                  key={idx}
                  className="px-3 py-2 text-left text-xs font-semibold text-slate-700 border border-slate-300"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={rowIdx % 2 === 0 ? "bg-white" : "bg-slate-50"}
              >
                {row.map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    className="px-3 py-2 text-xs text-slate-800 border border-slate-300"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      <p className="mt-2 text-[10px] text-slate-500">
        Řádků: {rows.length} | Sloupců: {headers.length}
      </p>
    </div>
  );
}
