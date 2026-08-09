<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { adminNavigationItems } from "./adminNavigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const route = useRoute();
const router = useRouter();
const { setOpenMobile } = useSidebar();

const selected = (path: string) =>
  path === "/" ? route.path === "/" : route.path.startsWith(path);

async function navigate(path: string) {
  await router.push(path);
  setOpenMobile(false);
}
</script>

<template>
  <SidebarGroup>
    <SidebarGroupLabel>Панель администратора</SidebarGroupLabel>
    <SidebarGroupContent>
      <SidebarMenu>
        <SidebarMenuItem v-for="item in adminNavigationItems" :key="item.path">
          <SidebarMenuButton
            :is-active="selected(item.path)"
            :aria-current="selected(item.path) ? 'page' : undefined"
            @click="navigate(item.path)"
          >
            <component :is="item.icon" />
            <span>{{ item.label }}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroupContent>
  </SidebarGroup>
</template>
