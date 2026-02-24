import { useState, useCallback, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileSpreadsheet, X, AlertCircle } from "lucide-react";
import { type AsinInput } from "@shared/schema";

interface FileUploadProps {
  onFileProcessed: (asins: AsinInput[]) => void;
  isAnalyzing: boolean;
}

export function FileUpload({ onFileProcessed, isAnalyzing }: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
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
      onFileProcessed(data.asins);
    } catch (err: any) {
      setError(err.message || "Failed to parse file");
      setFile(null);
    }
  }, [onFileProcessed]);

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
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
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
                File must have ASIN and COGS columns
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
  );
}
