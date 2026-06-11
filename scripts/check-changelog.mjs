// scripts/check-changelog.mjs
// validate changelog release gates

import { existsSync, readFileSync } from 'node:fs'

const changelogPath = 'CHANGELOG.md'
const packagePath = 'package.json'
const packageLockPath = 'package-lock.json'
const errors = []

function escapeRegExp(value)
{
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readJson(path)
{
  return JSON.parse(readFileSync(path, 'utf8'))
}

const pkg = readJson(packagePath)
const changelog = readFileSync(changelogPath, 'utf8')
const headings = [
  ...changelog.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm),
].map((match) => ({
  date: match[2],
  index: match.index ?? 0,
  title: match[1],
}))

if (!changelog.startsWith('# Changelog\n'))
{
  errors.push('CHANGELOG.md must start with "# Changelog".')
}

if (headings.length === 0)
{
  errors.push('CHANGELOG.md must contain release headings.')
}

if (headings[0]?.title !== 'Unreleased')
{
  errors.push('CHANGELOG.md must keep "## [Unreleased]" as the first entry.')
}

const duplicateHeadings = headings
  .map((heading) => heading.title)
  .filter((title, index, titles) => titles.indexOf(title) !== index)

if (duplicateHeadings.length > 0)
{
  errors.push(`Duplicate changelog headings: ${duplicateHeadings.join(', ')}.`)
}

for (const heading of headings)
{
  if (heading.title !== 'Unreleased' && !heading.date)
  {
    errors.push(`Changelog entry ${heading.title} must include a date.`)
  }
}

const versionHeadingPattern = new RegExp(
  `^## \\[${escapeRegExp(pkg.version)}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  'm'
)

if (!versionHeadingPattern.test(changelog))
{
  errors.push(`Missing changelog entry for package version ${pkg.version}.`)
}

const versionHeading = headings.find((heading) => heading.title === pkg.version)
const nextHeading = headings.find(
  (heading) =>
    heading.index > (versionHeading?.index ?? Number.MAX_SAFE_INTEGER)
)

if (versionHeading)
{
  const versionBody = changelog.slice(
    versionHeading.index,
    nextHeading?.index ?? changelog.length
  )

  if (!/^### /m.test(versionBody))
  {
    errors.push(
      `Changelog entry ${pkg.version} must include category headings.`
    )
  }
}

if (existsSync(packageLockPath))
{
  const lock = readJson(packageLockPath)

  if (lock.version && lock.version !== pkg.version)
  {
    errors.push(
      `package-lock.json version ${lock.version} must match package.json ${pkg.version}.`
    )
  }

  if (lock.packages?.['']?.version !== pkg.version)
  {
    errors.push(
      `package-lock root version ${lock.packages?.['']?.version} must match package.json ${pkg.version}.`
    )
  }
}

if (errors.length > 0)
{
  console.error('\nChangelog check failed:\n')
  for (const error of errors)
  {
    console.error(`- ${error}`)
  }
  console.error('')
  process.exit(1)
}

console.log(`Changelog entry found for v${pkg.version}`)
