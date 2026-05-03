import { driveClient } from "./google.js";

export type DriveHit = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
};

export async function searchDrive(query: string, limit = 10): Promise<DriveHit[]> {
  const drive = driveClient();
  const escaped = query.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
    pageSize: limit,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
  });
  return (res.data.files ?? []) as DriveHit[];
}

export async function readDriveFile(fileId: string, maxChars = 8000): Promise<string> {
  const drive = driveClient();
  const meta = await drive.files.get({ fileId, fields: "mimeType,name" });
  const mime = meta.data.mimeType ?? "";

  if (mime === "application/vnd.google-apps.document") {
    const exp = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
    return String(exp.data).slice(0, maxChars);
  }
  if (mime === "application/vnd.google-apps.spreadsheet") {
    const exp = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
    return String(exp.data).slice(0, maxChars);
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    const dl = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    return String(dl.data).slice(0, maxChars);
  }
  return `[${meta.data.name}] (${mime}) — binary file, not extracted`;
}
