// The inventory: everything the player can equip, by category. A category lists its items (each with a preview
// picture, a name, a pitch and a locked flag), says which one is equipped and equips another. To add a category
// (helmets, celebrations, ...) add one entry to CATEGORIES: the menu builds its tab from it.
import { SKINS, skinById } from './render/skin';
import { STADIUMS, stadiumById } from './render/stadium';
import type { Settings } from './settings';

export interface InventoryItem { id: string; label: string; pitch: string; /** Path under the site root, or null for a drawn placeholder. */ preview: string | null; unlocked: boolean }
export interface InventoryCategory {
  id: string;
  label: string;
  items(): InventoryItem[];
  equipped(s: Settings): string;
  /** Equip an item by id (the caller has checked it exists and is unlocked). */
  equip(s: Settings, id: string): void;
}

const asItem = ({ id, label, pitch, preview, unlocked }: { id: string; label: string; pitch: string; preview?: string | null; unlocked: boolean }): InventoryItem => ({ id, label, pitch, preview: preview ?? null, unlocked });

export const CATEGORIES: InventoryCategory[] = [
  { id: 'skins', label: 'Skins', items: () => SKINS.map(asItem), equipped: (s) => skinById(s.skin).id, equip: (s, id) => { s.skin = id; } },
  { id: 'stadiums', label: 'Stadiums', items: () => STADIUMS.map(asItem), equipped: (s) => stadiumById(s.stadium).id, equip: (s, id) => { s.stadium = id; } },
];

/** Equip `itemId` of category `catId`; false (nothing changes) if either is unknown or the item is locked. */
export function equipItem(s: Settings, catId: string, itemId: string): boolean {
  const cat = CATEGORIES.find((c) => c.id === catId), item = cat?.items().find((i) => i.id === itemId);
  if (!cat || !item?.unlocked) return false;
  cat.equip(s, itemId);
  return true;
}
