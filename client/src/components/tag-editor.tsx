import { useState, useEffect, useMemo, Fragment } from "react";
import { Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { compareTagRecords } from "@/lib/use-tag-groups";

interface Tag {
  id: string;
  name: string;
  color: string;
  tag_group?: string | null;
  sort_order?: number | null;
}

interface TagEditorProps {
  asin: string;
  currentTags: { name: string; color: string }[];
  onTagsChanged: (tags: { name: string; color: string }[]) => void;
}

export function TagEditor({ asin, currentTags, onTagsChanged }: TagEditorProps) {
  const [open, setOpen] = useState(false);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newTagName, setNewTagName] = useState("");
  const [saving, setSaving] = useState(false);

  // Fetch all tags when popover opens
  useEffect(() => {
    if (!open) return;
    fetch("/api/tags")
      .then((r) => r.json())
      .then((tags: Tag[]) => {
        setAllTags(tags);
        // Match current tags by name to get IDs
        const currentNames = new Set(currentTags.map((t) => t.name));
        const ids = new Set(tags.filter((t) => currentNames.has(t.name)).map((t) => t.id));
        setSelectedIds(ids);
      })
      .catch(() => {});
  }, [open, currentTags]);

  async function toggleTag(tagId: string) {
    const next = new Set(selectedIds);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    setSelectedIds(next);
    await saveTagIds(Array.from(next));
  }

  async function saveTagIds(tagIds: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/asins/${asin}/tags`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagIds }),
      });
      const updated: Tag[] = await res.json();
      onTagsChanged(updated.map((t) => ({ name: t.name, color: t.color })));
    } catch {}
    setSaving(false);
  }

  async function createAndAddTag() {
    const name = newTagName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const newTag: Tag = await res.json();
      setAllTags((prev) => [...prev, newTag]); // ordering handled at render (group-aware)
      const next = new Set(selectedIds);
      next.add(newTag.id);
      setSelectedIds(next);
      setNewTagName("");
      await saveTagIds(Array.from(next));
    } catch {}
    setSaving(false);
  }

  // Ungrouped tags first (alphabetical), then grouped tags (e.g. Seasonal) by
  // group + sort_order. Render inserts a header at each group boundary.
  const sortedTags = useMemo(() => [...allTags].sort(compareTagRecords), [allTags]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="flex flex-wrap gap-1 items-center cursor-pointer min-h-[24px]" onClick={(e) => e.stopPropagation()}>
          {currentTags.length > 0 ? (
            currentTags.map((t) => (
              <span
                key={t.name}
                className="inline-block text-[10px] leading-tight px-1.5 py-0.5 rounded-full font-medium text-white"
                style={{ backgroundColor: t.color }}
              >
                {t.name}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground text-sm">-</span>
          )}
          <Plus className="h-3 w-3 text-muted-foreground/50 hover:text-muted-foreground flex-shrink-0" />
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
        <div className="max-h-[250px] overflow-y-auto p-1">
          {sortedTags.map((tag, i) => {
            const checked = selectedIds.has(tag.id);
            const group = tag.tag_group ?? undefined;
            const showHeader = group && group !== (sortedTags[i - 1]?.tag_group ?? undefined);
            return (
              <Fragment key={tag.id}>
                {showHeader && (
                  <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                )}
                <button
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm hover:bg-muted transition-colors ${saving ? "opacity-50" : ""}`}
                  onClick={() => toggleTag(tag.id)}
                  disabled={saving}
                >
                  <span
                    className="w-3 h-3 rounded-sm flex-shrink-0 border"
                    style={{
                      backgroundColor: checked ? tag.color : "transparent",
                      borderColor: tag.color,
                    }}
                  />
                  <span className="truncate flex-1">{tag.name}</span>
                </button>
              </Fragment>
            );
          })}
        </div>
        <div className="border-t border-border p-2 flex gap-1">
          <Input
            placeholder="New tag..."
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            className="h-7 text-xs"
            onKeyDown={(e) => e.key === "Enter" && createAndAddTag()}
          />
          <Button size="sm" className="h-7 text-xs px-2" onClick={createAndAddTag} disabled={!newTagName.trim() || saving}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
