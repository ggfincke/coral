// src/utils/path-containment.ts
// lexical check that a path stays inside a directory

import { isAbsolute, relative, sep } from 'node:path'

export function isPathInsideProject(
  cwd: string,
  absolutePath: string
): boolean
{
  const projectPath = relative(cwd, absolutePath)
  return (
    projectPath === '' ||
    (!isAbsolute(projectPath) &&
      projectPath !== '..' &&
      !projectPath.startsWith(`..${sep}`))
  )
}
