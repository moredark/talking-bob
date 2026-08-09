<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import IconSymbol from "./IconSymbol.vue";

const route = useRoute();
const router = useRouter();
const { state, logout } = useAuth();
const drawerOpen = ref(false);
const items = [
  { path: "/", label: "Дашборд", icon: "dashboard" as const },
  { path: "/users", label: "Пользователи", icon: "users" as const },
  { path: "/prompts", label: "Промпты", icon: "prompts" as const },
  { path: "/topics", label: "Статистика тем", icon: "topics" as const },
  { path: "/error-logs", label: "Логи ошибок", icon: "errors" as const },
];
const selected = (path: string) => path === "/" ? route.path === "/" : route.path.startsWith(path);
const currentSection = computed(() => items.find((item) => selected(item.path))?.label ?? "Панель администратора");
function navigate(path: string) { drawerOpen.value = false; router.push(path); }
function signOut() { logout(); router.replace("/login"); }
</script>

<template>
  <div class="admin-shell">
    <aside class="sidebar" aria-label="Основная навигация">
      <div class="brand"><span class="brand__mark">TB</span><span><strong>Talking Bob</strong><small>Управление</small></span></div>
      <nav class="nav-list">
        <button v-for="item in items" :key="item.path" type="button" :class="['nav-item', { 'is-active': selected(item.path) }]" :aria-current="selected(item.path) ? 'page' : undefined" @click="navigate(item.path)">
          <IconSymbol :name="item.icon" />{{ item.label }}
        </button>
      </nav>
      <div class="sidebar__footer"><div class="admin-avatar">{{ state.user?.username?.slice(0, 1).toUpperCase() }}</div><div class="admin-name"><small>Администратор</small><strong>{{ state.user?.username }}</strong></div><el-button text circle aria-label="Выйти" @click="signOut"><IconSymbol name="logout" /></el-button></div>
    </aside>

    <div class="main-column">
      <header class="topbar">
        <el-button class="mobile-menu" text circle aria-label="Открыть меню" @click="drawerOpen = true"><IconSymbol name="menu" /></el-button>
        <strong class="topbar__title">{{ currentSection }}</strong>
        <el-button class="topbar__logout" text aria-label="Выйти из панели администратора" @click="signOut"><IconSymbol name="logout" />Выйти</el-button>
      </header>
      <main class="content"><router-view /></main>
    </div>

    <el-drawer v-model="drawerOpen" direction="ltr" size="min(320px, 86vw)" :with-header="false">
      <div class="brand drawer-brand"><span class="brand__mark">TB</span><span><strong>Talking Bob</strong><small>Управление</small></span></div>
      <nav class="nav-list" aria-label="Мобильная навигация">
        <button v-for="item in items" :key="item.path" type="button" :class="['nav-item', { 'is-active': selected(item.path) }]" :aria-current="selected(item.path) ? 'page' : undefined" @click="navigate(item.path)"><IconSymbol :name="item.icon" />{{ item.label }}</button>
      </nav>
    </el-drawer>
  </div>
</template>
