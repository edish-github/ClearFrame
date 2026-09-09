import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { AppShell } from "@/components/shell/AppShell";
import { SignIn } from "@/pages/SignIn";
import { Productions } from "@/pages/Productions";
import { NewPass } from "@/pages/NewPass";
import { Workspace } from "@/pages/Workspace";
import { FindingDetail } from "@/pages/FindingDetail";
import { Approvals } from "@/pages/Approvals";
import { Reports } from "@/pages/Reports";

function Gate() {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <Loader2 size={18} />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="*" element={<Navigate to="/sign-in" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/productions" element={<Productions />} />
        <Route path="/productions/new" element={<NewPass />} />
        <Route path="/productions/:id" element={<Workspace />} />
        <Route path="/findings/:id" element={<FindingDetail />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/reports" element={<Reports />} />
      </Route>
      <Route path="*" element={<Navigate to="/productions" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
