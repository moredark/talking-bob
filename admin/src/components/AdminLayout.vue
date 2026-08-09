<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { BarChart3, LogOut } from "@lucide/vue";
import { useAuth } from "../composables/useAuth";
import AdminSidebarNavigation from "./AdminSidebarNavigation.vue";
import { adminNavigationItems } from "./adminNavigation";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

const route = useRoute();
const router = useRouter();
const { state, logout } = useAuth();
const selected = (path: string) => path === "/" ? route.path === "/" : route.path.startsWith(path);
const currentSection = computed(() => adminNavigationItems.find((item) => selected(item.path))?.label ?? "Панель администратора");
function signOut() { logout(); router.replace("/login"); }
</script>

<template>
  <SidebarProvider>
    <Sidebar collapsible="offcanvas" aria-label="Основная навигация">
      <SidebarHeader>
        <div class="flex items-center gap-3 px-2 py-2">
          <div class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><BarChart3 class="size-5" /></div>
          <div class="min-w-0"><p class="truncate text-sm font-semibold">Talking Bob</p><p class="text-xs text-muted-foreground">Управление</p></div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <AdminSidebarNavigation />
      </SidebarContent>
      <SidebarFooter>
        <Separator />
        <div class="flex items-center gap-3 p-2">
          <Avatar class="size-8"><AvatarFallback>{{ state.user?.username?.slice(0, 1).toUpperCase() || "A" }}</AvatarFallback></Avatar>
          <div class="min-w-0 flex-1"><p class="truncate text-xs text-muted-foreground">Администратор</p><p class="truncate text-sm font-medium">{{ state.user?.username }}</p></div>
          <Button variant="ghost" size="icon-sm" aria-label="Выйти" @click="signOut"><LogOut /></Button>
        </div>
      </SidebarFooter>
    </Sidebar>
    <SidebarInset>
      <header class="sticky top-0 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" class="h-5" />
        <strong class="text-sm font-medium">{{ currentSection }}</strong>
        <Button variant="ghost" size="sm" class="ml-auto md:hidden" @click="signOut"><LogOut data-icon="inline-start" />Выйти</Button>
      </header>
      <main class="mx-auto w-full max-w-[1500px] p-4 md:p-8"><router-view /></main>
    </SidebarInset>
  </SidebarProvider>
</template>
