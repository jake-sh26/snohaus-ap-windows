// Vendor Groups
// ---------------
// Round 7: Some QBO "vendors" are actually parent companies that ship invoices
// for multiple sub-brands. Examples Jake gave:
//   - Amer Sports → Atomic, Salomon
//   - Rossignol Groupe → Rossignol, Dynastar, Lange
// When the LLM parser matches the parent name, we can't auto-pick which brand
// to attribute the inventory to. So we let Jake configure groups + brand
// keywords here, then in the drawer he gets a brand picker (auto-suggesting
// from PDF text + line_items) instead of a single vendor name.
//
// Each "member" is itself a real QBO vendor — picking a member just rewrites
// the invoice's vendor_qbo_id/name to that member's. Groups never replace QBO
// vendors; they just route disambiguation in the drawer.

import Database from "better-sqlite3";

let _db: Database.Database | null = null;
function getDb() {
  if (_db) return _db;
  _db = new Database("data.db");
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_qbo_id TEXT,
      parent_qbo_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vendor_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      vendor_qbo_id TEXT NOT NULL,
      vendor_qbo_name TEXT NOT NULL,
      brand_keywords TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES vendor_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vgm_group ON vendor_group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_vgm_vendor ON vendor_group_members(vendor_qbo_id);
    CREATE INDEX IF NOT EXISTS idx_vg_parent ON vendor_groups(parent_qbo_id);
  `);
  return _db;
}

export interface VendorGroup {
  id: number;
  name: string;
  parent_qbo_id: string | null;
  parent_qbo_name: string | null;
  created_at: string;
}
export interface VendorGroupMember {
  id: number;
  group_id: number;
  vendor_qbo_id: string;
  vendor_qbo_name: string;
  brand_keywords: string | null;
  created_at: string;
}
export interface VendorGroupWithMembers extends VendorGroup {
  members: VendorGroupMember[];
}

export function listVendorGroups(): VendorGroupWithMembers[] {
  const db = getDb();
  const groups = db.prepare(`SELECT * FROM vendor_groups ORDER BY name`).all() as VendorGroup[];
  const members = db.prepare(`SELECT * FROM vendor_group_members ORDER BY vendor_qbo_name`).all() as VendorGroupMember[];
  const byGroup = new Map<number, VendorGroupMember[]>();
  for (const m of members) {
    if (!byGroup.has(m.group_id)) byGroup.set(m.group_id, []);
    byGroup.get(m.group_id)!.push(m);
  }
  return groups.map((g) => ({ ...g, members: byGroup.get(g.id) || [] }));
}

export function getVendorGroup(id: number): VendorGroupWithMembers | null {
  const db = getDb();
  const g = db.prepare(`SELECT * FROM vendor_groups WHERE id = ?`).get(id) as VendorGroup | undefined;
  if (!g) return null;
  const members = db.prepare(`SELECT * FROM vendor_group_members WHERE group_id = ? ORDER BY vendor_qbo_name`).all(id) as VendorGroupMember[];
  return { ...g, members };
}

export function createVendorGroup(data: {
  name: string;
  parent_qbo_id?: string | null;
  parent_qbo_name?: string | null;
}): VendorGroupWithMembers {
  const db = getDb();
  const info = db.prepare(`INSERT INTO vendor_groups (name, parent_qbo_id, parent_qbo_name) VALUES (?,?,?)`)
    .run(data.name, data.parent_qbo_id || null, data.parent_qbo_name || null);
  return getVendorGroup(Number(info.lastInsertRowid))!;
}

export function updateVendorGroup(id: number, patch: Partial<VendorGroup>): VendorGroupWithMembers | null {
  const db = getDb();
  const fields: string[] = [];
  const args: any[] = [];
  for (const k of ["name", "parent_qbo_id", "parent_qbo_name"] as const) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      args.push((patch as any)[k]);
    }
  }
  if (fields.length) {
    db.prepare(`UPDATE vendor_groups SET ${fields.join(", ")} WHERE id = ?`).run(...args, id);
  }
  return getVendorGroup(id);
}

export function deleteVendorGroup(id: number): { ok: boolean } {
  const db = getDb();
  db.prepare(`DELETE FROM vendor_group_members WHERE group_id = ?`).run(id);
  db.prepare(`DELETE FROM vendor_groups WHERE id = ?`).run(id);
  return { ok: true };
}

export function addGroupMember(data: {
  group_id: number;
  vendor_qbo_id: string;
  vendor_qbo_name: string;
  brand_keywords?: string | null;
}): VendorGroupMember {
  const db = getDb();
  // De-dupe: if (group_id, vendor_qbo_id) already exists, just update keywords.
  const existing = db.prepare(`SELECT * FROM vendor_group_members WHERE group_id = ? AND vendor_qbo_id = ?`)
    .get(data.group_id, data.vendor_qbo_id) as VendorGroupMember | undefined;
  if (existing) {
    db.prepare(`UPDATE vendor_group_members SET vendor_qbo_name = ?, brand_keywords = ? WHERE id = ?`)
      .run(data.vendor_qbo_name, data.brand_keywords || null, existing.id);
    return { ...existing, vendor_qbo_name: data.vendor_qbo_name, brand_keywords: data.brand_keywords || null };
  }
  const info = db.prepare(`INSERT INTO vendor_group_members (group_id, vendor_qbo_id, vendor_qbo_name, brand_keywords) VALUES (?,?,?,?)`)
    .run(data.group_id, data.vendor_qbo_id, data.vendor_qbo_name, data.brand_keywords || null);
  return db.prepare(`SELECT * FROM vendor_group_members WHERE id = ?`).get(info.lastInsertRowid) as VendorGroupMember;
}

export function updateGroupMember(id: number, patch: Partial<VendorGroupMember>): VendorGroupMember | null {
  const db = getDb();
  const fields: string[] = [];
  const args: any[] = [];
  for (const k of ["vendor_qbo_id", "vendor_qbo_name", "brand_keywords"] as const) {
    if (k in patch) {
      fields.push(`${k} = ?`);
      args.push((patch as any)[k]);
    }
  }
  if (fields.length) {
    db.prepare(`UPDATE vendor_group_members SET ${fields.join(", ")} WHERE id = ?`).run(...args, id);
  }
  return db.prepare(`SELECT * FROM vendor_group_members WHERE id = ?`).get(id) as VendorGroupMember | null;
}

export function deleteGroupMember(id: number): { ok: boolean } {
  const db = getDb();
  db.prepare(`DELETE FROM vendor_group_members WHERE id = ?`).run(id);
  return { ok: true };
}

/**
 * Find which group (if any) this QBO vendor belongs to.
 * A vendor can belong to at most one group (by parent_qbo_id match OR by being
 * a member). Returns the group + its sibling members for disambiguation.
 */
export function findGroupForVendor(vendorQboId: string | null | undefined): VendorGroupWithMembers | null {
  if (!vendorQboId) return null;
  const db = getDb();
  // Match by parent
  const byParent = db.prepare(`SELECT id FROM vendor_groups WHERE parent_qbo_id = ? LIMIT 1`).get(vendorQboId) as { id: number } | undefined;
  if (byParent) return getVendorGroup(byParent.id);
  // Match by member
  const byMember = db.prepare(`SELECT group_id FROM vendor_group_members WHERE vendor_qbo_id = ? LIMIT 1`).get(vendorQboId) as { group_id: number } | undefined;
  if (byMember) return getVendorGroup(byMember.group_id);
  return null;
}

/**
 * Score each member of a group against a haystack of PDF text + line item
 * descriptions. Higher score = better brand match. Returns members sorted by
 * score descending. Members with score=0 are still included so the user can
 * pick manually.
 */
export function suggestGroupMember(
  group: VendorGroupWithMembers,
  haystack: string,
): Array<VendorGroupMember & { score: number; matched_keywords: string[] }> {
  const text = (haystack || "").toLowerCase();
  return group.members
    .map((m) => {
      const keywords = (m.brand_keywords || "")
        .split(/[,;\n]/)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean);
      const matched: string[] = [];
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) {
          matched.push(kw);
          score += kw.length >= 4 ? 2 : 1; // longer keyword = stronger signal
        }
      }
      // Brand name itself is also a keyword
      const nameLower = m.vendor_qbo_name.toLowerCase();
      if (nameLower && text.includes(nameLower)) {
        matched.push(m.vendor_qbo_name);
        score += 3;
      }
      return { ...m, score, matched_keywords: matched };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Round 7 follow-up: scan ALL groups against a haystack and pick the best one.
 * Used by the drawer when the matched vendor isn't yet part of any group, so
 * Jake can still get a brand picker if PDF text mentions e.g. "Atomic" or
 * "Salomon". Returns the group + scored members of the best-matching group.
 * Returns null when no group has any keyword/brand-name hits.
 */
export function autoDetectGroup(
  haystack: string,
): { group: VendorGroupWithMembers; suggestions: Array<VendorGroupMember & { score: number; matched_keywords: string[] }> } | null {
  const all = listVendorGroups();
  if (!all.length) return null;
  const text = (haystack || "").toLowerCase();
  let best: { group: VendorGroupWithMembers; suggestions: any[]; score: number } | null = null;
  for (const g of all) {
    const suggestions = suggestGroupMember(g, haystack);
    const memberTopScore = suggestions[0]?.score || 0;
    // Also score the GROUP itself: if the group name (e.g. "Amer Sports") or
    // its parent QBO vendor name appears in the PDF, treat that as a strong
    // signal even when no member-level keyword matched. This is the common
    // case where the parent vendor is on the invoice but Jake hasn't yet
    // assigned the QBO vendor or added member keywords.
    let groupScore = 0;
    const groupNameLower = (g.name || "").toLowerCase().trim();
    const parentNameLower = (g.parent_qbo_name || "").toLowerCase().trim();
    if (groupNameLower && groupNameLower.length >= 3 && text.includes(groupNameLower)) groupScore += 3;
    if (parentNameLower && parentNameLower.length >= 3 && parentNameLower !== groupNameLower && text.includes(parentNameLower)) groupScore += 3;
    const totalScore = memberTopScore + groupScore;
    if (totalScore > 0 && (!best || totalScore > best.score)) {
      best = { group: g, suggestions, score: totalScore };
    }
  }
  if (!best) return null;
  return { group: best.group, suggestions: best.suggestions };
}
