// src/utils/tool-name.ts
// canonical tool-name normalization shared by agent repair & MCP collision checks

// lowercase & strip separators so Read_File / READFILE match read_file
export function normalizeToolName(name: string): string
{
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
