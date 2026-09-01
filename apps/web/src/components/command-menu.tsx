'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Search, FileSpreadsheet, Building2, Activity, ArrowRight } from 'lucide-react';

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const runCommand = (command: () => void) => {
    setOpen(false);
    command();
  };

  return (
    <>
      {/* A search field's shape, because that is what it does. It read as
          "Quick Command Palette…" on two wrapped lines in a 224px rail, which
          is a label describing the mechanism rather than the job. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex h-9 w-full cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-border bg-surface-2 px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong hover:text-muted"
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span>Search</span>
        <kbd className="ml-auto rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-subtle">
          ⌘K
        </kbd>
      </button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Search DataEngine…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => runCommand(() => router.push('/app'))}>
              <FileSpreadsheet className="h-4 w-4 text-subtle" />
              <span>Categorise a file</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => router.push('/app/workspaces'))}>
              <Building2 className="h-4 w-4 text-subtle" />
              <span>Workspaces</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </CommandItem>
            <CommandItem onSelect={() => runCommand(() => router.push('/app/audit'))}>
              <Activity className="h-4 w-4 text-subtle" />
              <span>Activity log</span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
