import { Routes, Route, useNavigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { Users } from "./pages/Users";
import { UserDetail } from "./pages/UserDetail";
import { Topics } from "./pages/Topics";
import { Prompts } from "./pages/Prompts";
import { ErrorLogs } from "./pages/ErrorLogs";

export function App() {
  const { isAuthenticated, isLoading, user, login, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <Routes>
      <Route
        path="/login"
        element={<Login onLogin={login} isAuthenticated={isAuthenticated} />}
      />
      <Route
        element={
          <ProtectedRoute
            isAuthenticated={isAuthenticated}
            isLoading={isLoading}
          >
            <Layout onLogout={handleLogout} username={user?.username || ""} />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/users/:id" element={<UserDetail />} />
        <Route path="/prompts" element={<Prompts />} />
        <Route path="/topics" element={<Topics />} />
        <Route path="/error-logs" element={<ErrorLogs />} />
      </Route>
    </Routes>
  );
}
