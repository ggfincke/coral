// src/utils/tool-name.ts
// canonical tool-name normalization shared by agent repair and MCP collision checks

// lowercase and strip separators so Read_File and READFILE match read_file
export function normalizeToolName(name: string): string
{
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}
