// src/tui/theme.ts
// coral/pink/ocean color palette — inspired by Pink Ocean Collectibles

import chalk from 'chalk'

// brand coral — warm orange-pink, the primary accent
export const CORAL = { r: 255, g: 127, b: 80 }
export const CORAL_HEX = '#FF7F50'
// soft pink — lighter variant for secondary accents & highlights
export const PINK = { r: 255, g: 160, b: 170 }
// ocean teal — cool complement for interactive/user elements
export const OCEAN = { r: 0, g: 190, b: 180 }
export const OCEAN_HEX = '#00BEB4'
// deep blue — subtle accent for code, links, tool connectors
export const DEEP = { r: 90, g: 150, b: 200 }
// sand — warm neutral for dimmed/secondary text
export const SAND = { r: 180, g: 160, b: 140 }

// pre-built chalk styles for common use
export const coral = chalk.rgb(CORAL.r, CORAL.g, CORAL.b)
export const coralBold = chalk.bold.rgb(CORAL.r, CORAL.g, CORAL.b)
export const pink = chalk.rgb(PINK.r, PINK.g, PINK.b)
export const pinkBold = chalk.bold.rgb(PINK.r, PINK.g, PINK.b)
export const ocean = chalk.rgb(OCEAN.r, OCEAN.g, OCEAN.b)
export const oceanBold = chalk.bold.rgb(OCEAN.r, OCEAN.g, OCEAN.b)
export const deep = chalk.rgb(DEEP.r, DEEP.g, DEEP.b)
export const deepBold = chalk.bold.rgb(DEEP.r, DEEP.g, DEEP.b)
export const sand = chalk.rgb(SAND.r, SAND.g, SAND.b)
