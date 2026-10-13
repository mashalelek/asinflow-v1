import { useState, useCallback, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileSpreadsheet, X, AlertCircle, Download } from "lucide-react";
import { type AsinInput, type ColumnMapping } from "@shared/schema";
import { ColumnMappingModal } from "@/components/column-mapping-modal";

interface FileUploadProps {
  onFileProcessed: (asins: AsinInput[], sourceFilename?: string) => void;
  isAnalyzing: boolean;
  compact?: boolean;
  // §21 bulk page: COGS column optional (supplier catalogs often have none).
  // Default (false) preserves the main upload flow exactly.
  cogsOptional?: boolean;
}

export function FileUpload({ onFileProcessed, isAnalyzing, compact, cogsOptional = false }: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [showMapping, setShowMapping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (f: File) => {
    setError(null);
    setFile(f);

    const formData = new FormData();
    formData.append("file", f);

    try {
      const res = await fetch("/api/parse-file", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to parse file");
      }

      const data = await res.json();
      if (data.headers && data.headers.length > 0) {
        setHeaders(data.headers);
        setShowMapping(true);
      } else {
        throw new Error("No columns found in the file.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to parse file");
      setFile(null);
    }
  }, []);

  const handleMappingContinue = useCallback(async (mapping: ColumnMapping, leadSource: string | null) => {
    if (!file) return;
    setShowMapping(false);
    setError(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("mapping", JSON.stringify(mapping));
    if (cogsOptional) formData.append("allowMissingCogs", "true");
    // §6: the dialog's list-wide pick. Omitted entirely when None, so the
    // server sees undefined and leaves lead_source NULL.
    if (leadSource) formData.append("leadSource", leadSource);

    try {
      const res = await fetch("/api/parse-mapped", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to process file");
      }

      const data = await res.json();
      onFileProcessed(data.asins, file.name);
    } catch (err: any) {
      setError(err.message || "Failed to process file");
      setFile(null);
    }
  }, [file, onFileProcessed, cogsOptional]);

  const handleMappingCancel = useCallback(() => {
    setShowMapping(false);
    setFile(null);
    setHeaders([]);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  }, [processFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) processFile(f);
  }, [processFile]);

  const clearFile = () => {
    setFile(null);
    setError(null);
    setHeaders([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleDownloadTemplate = () => {
    window.open("/api/download-template", "_blank");
  };

  if (compact) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={isAnalyzing}
          className="h-8 text-xs"
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          {file ? file.name : "Upload File"}
        </Button>
        <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleChange} className="hidden" />
        <ColumnMappingModal open={showMapping} headers={headers} onCancel={handleMappingCancel} onContinue={handleMappingContinue} cogsRequired={!cogsOptional} />
      </>
    );
  }

  return (
    <>
      <div className="space-y-2">
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDownloadTemplate}
            className="text-xs text-muted-foreground"
            data-testid="button-download-template"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Download Template
          </Button>
        </div>
        <Card
          className={`relative border-2 border-dashed transition-colors duration-200 ${
            isDragOver
              ? "border-primary bg-primary/5"
              : file
              ? "border-chart-2/50 bg-chart-2/5"
              : "border-border"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          data-testid="dropzone-file-upload"
        >
          <div className="p-6 flex flex-col items-center gap-3 text-center">
            {file ? (
              <>
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-6 w-6 text-chart-2" />
                  <span className="text-sm font-medium" data-testid="text-filename">{file.name}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={clearFile}
                    disabled={isAnalyzing}
                    data-testid="button-clear-file"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Upload className="h-8 w-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Drop your CSV or Excel file here</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    ASIN and COGS required. Buy Link, Prep Cost, and Additional Fees optional.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => inputRef.current?.click()}
                  data-testid="button-browse-file"
                >
                  Browse Files
                </Button>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleChange}
              className="hidden"
              data-testid="input-file"
            />
          </div>

          {error && (
            <div className="px-6 pb-4">
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span data-testid="text-file-error">{error}</span>
              </div>
            </div>
          )}
        </Card>
      </div>

      <ColumnMappingModal
        open={showMapping}
        headers={headers}
        onCancel={handleMappingCancel}
        onContinue={handleMappingContinue}
        cogsRequired={!cogsOptional}
      />
    </>
  );
}
