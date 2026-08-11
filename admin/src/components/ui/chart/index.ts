export { default as ChartContainer } from "./ChartContainer.vue";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
}

export interface ChartDatum {
  label: string;
  [key: string]: string | number | null;
}
