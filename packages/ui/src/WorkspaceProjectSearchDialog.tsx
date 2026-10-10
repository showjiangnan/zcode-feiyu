// Modified by ZCode Feiyu contributors (2026).
import { useMemo, useState } from "react";
import { Folder } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { projectNameMatches } from "@/lib/sidebarPresentation.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { formatRemoteWorkspaceDisplayLabel } from "@/lib/remoteWorkspaceHistory.js";
import { useSidebarPresentationStore } from "@/store/sidebarPresentationStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { QuickPickSearchField } from "@/quickpick/QuickPickSearchField.js";
import {
  quickPickCommandClassName,
  quickPickItemClassName,
  quickPickMetadataClassName,
  quickPickSearchDialogClassName,
  quickPickSearchHeaderClassName,
  quickPickSearchListClassName,
} from "@/quickpick/quickPickStyles.js";

export function WorkspaceProjectSearchDialog({
  open,
  onOpenChange,
  projects,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: WorkspaceTabState[];
  onSelect: (project: WorkspaceTabState) => void;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const preferences = useSidebarPresentationStore((state) => state.preferences.projects);
  const results = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          name:
            preferences[buildTaskWorkspaceKey(project.workspacePath, project.workspaceIdentity)]
              ?.label ?? formatRemoteWorkspaceDisplayLabel(project.label, project.remoteTarget),
        }))
        .filter(({ name }) => projectNameMatches(name, query)),
    [projects, preferences, query],
  );
  const title = intl.formatMessage({ id: "workspaceSidebar.searchProjects" });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setQuery("");
      }}
    >
      <DialogContent className={quickPickSearchDialogClassName} showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "workspaceSidebar.searchProjectsDescription" })}
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} loop className={quickPickCommandClassName}>
          <div className={quickPickSearchHeaderClassName}>
            <QuickPickSearchField
              value={query}
              onValueChange={setQuery}
              placeholder={title}
              aria-label={title}
            />
          </div>
          <CommandList className={quickPickSearchListClassName}>
            <CommandEmpty>
              {intl.formatMessage({ id: "workspaceSidebar.noMatchingProjects" })}
            </CommandEmpty>
            {results.map(({ project, name }) => (
              <CommandItem
                key={project.id}
                value={project.id}
                className={quickPickItemClassName}
                onSelect={() => {
                  onSelect(project);
                  onOpenChange(false);
                  setQuery("");
                }}
              >
                <Folder aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate text-ui-base">{name}</span>
                <CommandShortcut className={quickPickMetadataClassName}>
                  {project.workspacePath}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
