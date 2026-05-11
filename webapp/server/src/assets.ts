/**
 * Asset bundling — re-uses shared/assets/build.ts and loader.ts to decode
 * PNG sprites and build the furniture catalog at boot.
 *
 * Returns a payload that maps 1:1 onto the WS messages the webview expects:
 *   characterSpritesLoaded → characters
 *   floorTilesLoaded       → floorSprites
 *   wallTilesLoaded        → wallSets
 *   furnitureAssetsLoaded  → catalog + furnitureSprites
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFurnitureCatalog } from '../../../shared/assets/build.js';
import {
  decodeAllCharacters,
  decodeAllFloors,
  decodeAllFurniture,
  decodeAllWalls,
} from '../../../shared/assets/loader.js';
import type { CatalogEntry, CharacterDirectionSprites } from '../../../shared/assets/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Locate the webview-ui/public/assets directory regardless of cwd. */
export function resolveAssetsDir(): string {
  // server/src → ../../../webview-ui/public/assets
  return path.resolve(__dirname, '..', '..', '..', 'webview-ui', 'public', 'assets');
}

export interface AssetBundle {
  characters: CharacterDirectionSprites[];
  floorSprites: string[][][];
  wallSets: string[][][][];
  catalog: CatalogEntry[];
  furnitureSprites: Record<string, string[][]>;
}

export function loadAssetBundle(assetsDir: string): AssetBundle {
  const catalog = buildFurnitureCatalog(assetsDir);
  return {
    characters: decodeAllCharacters(assetsDir),
    floorSprites: decodeAllFloors(assetsDir),
    wallSets: decodeAllWalls(assetsDir),
    catalog,
    furnitureSprites: decodeAllFurniture(assetsDir, catalog),
  };
}
