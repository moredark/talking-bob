<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { BarChart3, LogIn } from "@lucide/vue";
import { toast } from "vue-sonner";
import { useAuth } from "../composables/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
const router = useRouter(); const route = useRoute(); const { login } = useAuth(); const loading = ref(false); const errors = reactive({ username: "", password: "" }); const form = reactive({ username: "", password: "" });
async function submit() {
  errors.username = form.username.trim() ? "" : "Введите логин"; errors.password = form.password ? "" : "Введите пароль"; if (errors.username || errors.password) return;
  loading.value = true;
  try { await login(form.username, form.password); toast.success("Вход выполнен"); await router.replace(typeof route.query.redirect === "string" ? route.query.redirect : "/"); }
  catch { toast.error("Неверный логин или пароль"); } finally { loading.value = false; }
}
</script>
<template>
  <main class="login-page">
    <Card class="w-full max-w-md">
      <CardHeader class="gap-4"><div class="flex items-center gap-3"><div class="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><BarChart3 class="size-5" /></div><div><p class="font-semibold">Talking Bob</p><p class="text-xs text-muted-foreground">Admin workspace</p></div></div><div><p class="eyebrow">Добро пожаловать</p><CardTitle class="mt-1 text-2xl">Вход в панель управления</CardTitle><CardDescription class="mt-2">Управляйте пользователями, промптами и качеством работы бота.</CardDescription></div></CardHeader>
      <CardContent><form @submit.prevent="submit"><FieldGroup><Field :data-invalid="!!errors.username"><FieldLabel for="username">Логин</FieldLabel><Input id="username" v-model="form.username" autocomplete="username" placeholder="Введите логин" :aria-invalid="!!errors.username" /><FieldError v-if="errors.username">{{ errors.username }}</FieldError></Field><Field :data-invalid="!!errors.password"><FieldLabel for="password">Пароль</FieldLabel><Input id="password" v-model="form.password" type="password" autocomplete="current-password" placeholder="Введите пароль" :aria-invalid="!!errors.password" /><FieldError v-if="errors.password">{{ errors.password }}</FieldError></Field><Button type="submit" class="w-full" :disabled="loading"><Spinner v-if="loading" data-icon="inline-start" /><LogIn v-else data-icon="inline-start" />Войти</Button></FieldGroup></form></CardContent>
    </Card>
  </main>
</template>
