<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { useAuth } from "../composables/useAuth";

const router = useRouter();
const route = useRoute();
const { login } = useAuth();
const formRef = ref<FormInstance>();
const loading = ref(false);
const form = reactive({ username: "", password: "" });
const rules: FormRules = {
  username: [{ required: true, message: "Введите логин", trigger: "blur" }],
  password: [{ required: true, message: "Введите пароль", trigger: "blur" }],
};
async function submit() {
  if (!await formRef.value?.validate().catch(() => false)) return;
  loading.value = true;
  try {
    await login(form.username, form.password);
    ElMessage.success("Вход выполнен");
    await router.replace(typeof route.query.redirect === "string" ? route.query.redirect : "/");
  } catch { ElMessage.error("Неверный логин или пароль"); }
  finally { loading.value = false; }
}
</script>
<template>
  <main class="login-page">
    <section class="login-card" aria-labelledby="login-title">
      <div class="brand login-brand"><span class="brand__mark">TB</span><span><strong>Talking Bob</strong><small>Admin workspace</small></span></div>
      <div class="login-copy"><p class="eyebrow">Добро пожаловать</p><h1 id="login-title">Вход в панель управления</h1><p>Управляйте пользователями, промптами и качеством работы бота.</p></div>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="large" @submit.prevent="submit">
        <el-form-item label="Логин" prop="username"><el-input v-model="form.username" autocomplete="username" placeholder="Введите логин" /></el-form-item>
        <el-form-item label="Пароль" prop="password"><el-input v-model="form.password" type="password" show-password autocomplete="current-password" placeholder="Введите пароль" @keyup.enter="submit" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading" :disabled="loading" class="login-submit">Войти</el-button>
      </el-form>
    </section>
  </main>
</template>
