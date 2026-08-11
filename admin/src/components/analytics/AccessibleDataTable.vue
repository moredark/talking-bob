<script setup lang="ts">
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface AnalyticsTableColumn {
  key: string;
  label: string;
}

const props = withDefaults(defineProps<{
  caption: string;
  columns: AnalyticsTableColumn[];
  rows: Array<Record<string, string | number>>;
  compact?: boolean;
}>(), {
  compact: false,
});
</script>

<template>
  <div :class="cn('overflow-x-auto', props.compact && 'max-h-64 overflow-y-auto')">
    <Table>
      <TableCaption>{{ caption }}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead v-for="column in columns" :key="column.key" scope="col">
            {{ column.label }}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="(row, rowIndex) in rows" :key="rowIndex">
          <TableCell v-for="column in columns" :key="column.key">
            {{ row[column.key] }}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
