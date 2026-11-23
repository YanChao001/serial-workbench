import { ListFilterIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkbenchIconButton } from "./workbench-icon-button";
import type { WorkbenchLabels } from "./labels";
import {
  MATCH_VISIBILITY,
  SEARCH_DIRECTIONS,
  type MatchVisibility,
  type SearchDirection,
} from "./stream-filter";

export function StreamFilterControls({
  labels,
  direction,
  visibility,
  hasQuery,
  onDirection,
  onVisibility,
}: {
  labels: WorkbenchLabels;
  direction: SearchDirection;
  visibility: MatchVisibility;
  hasQuery: boolean;
  onDirection: (value: SearchDirection) => void;
  onVisibility: (value: MatchVisibility) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <WorkbenchIconButton
          label={labels.searchFilters}
          variant={
            direction !== "all" || visibility !== "all" ? "secondary" : "ghost"
          }
        >
          <ListFilterIcon aria-hidden="true" />
        </WorkbenchIconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={labels.searchFilters}
        className="workbench-search-filters"
      >
        <label>
          {labels.searchDirection}
          <Select
            value={direction}
            onValueChange={(value) => {
              const next = SEARCH_DIRECTIONS.find((option) => option === value);
              if (next) onDirection(next);
            }}
          >
            <SelectTrigger aria-label={labels.searchDirection} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{labels.searchAllDirections}</SelectItem>
              <SelectItem value="rx">RX</SelectItem>
              <SelectItem value="tx">TX</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label>
          {labels.searchMatchVisibility}
          <Select
            value={visibility}
            disabled={!hasQuery}
            onValueChange={(value) => {
              const next = MATCH_VISIBILITY.find((option) => option === value);
              if (next) onVisibility(next);
            }}
          >
            <SelectTrigger aria-label={labels.searchMatchVisibility} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{labels.searchShowAll}</SelectItem>
              <SelectItem value="only">{labels.searchOnlyMatches}</SelectItem>
              <SelectItem value="hide">{labels.searchHideMatches}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </PopoverContent>
    </Popover>
  );
}
