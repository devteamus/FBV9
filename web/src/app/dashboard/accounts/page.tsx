"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PageAvatar } from "@/components/ui-kit";
import { Plus, Trash2, CheckCircle, Loader2 } from "lucide-react";

interface Account {
  id: string;
  name: string;
  fbPageId: string;
  fbApiVersion: string;
  isActive: boolean;
  createdAt: string;
  fbPagePictureUrl?: string | null;
  jobCount: number;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", fb_page_access_token: "", fb_page_id: "", fb_api_version: "v20.0" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    api.listAccounts().then((a) => { setAccounts(a); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.createAccount(form);
      setForm({ name: "", fb_page_access_token: "", fb_page_id: "", fb_api_version: "v20.0" });
      setShowForm(false);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this account and all its jobs?")) return;
    await api.deleteAccount(id);
    load();
  };

  const handleValidate = async (id: string) => {
    try {
      const res = await api.validateAccount(id);
      if (res.success) {
        alert(`Connected to: ${res.page?.name || "Unknown"}`);
      } else {
        alert("Validation failed: " + (res.error || "Unknown error"));
      }
    } catch (err: any) {
      alert("Validation failed: " + err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">Connect up to 100 Facebook pages</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add account
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-semibold">Connect new Facebook page</h3>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Account name</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="My Brand Page" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Page ID</label>
              <input required value={form.fb_page_id} onChange={(e) => setForm({ ...form, fb_page_id: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="1234567890" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm font-medium">Page Access Token</label>
              <input required type="password" value={form.fb_page_access_token} onChange={(e) => setForm({ ...form, fb_page_access_token: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="EAA..." />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">API Version</label>
              <select value={form.fb_api_version} onChange={(e) => setForm({ ...form, fb_api_version: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option>v19.0</option>
                <option>v20.0</option>
                <option>v21.0</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save account"}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted">Cancel</button>
          </div>
        </form>
      )}

      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b px-6 py-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Connected pages ({accounts.length}/100)</h2>
        </div>
        <div className="divide-y">
          {loading ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">Loading...</div>
          ) : accounts.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">No accounts connected yet.</div>
          ) : (
            accounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between px-6 py-4">
                <div className="flex items-center gap-3">
                  <PageAvatar name={acc.name} pictureUrl={acc.fbPagePictureUrl} />
                  <div>
                    <p className="text-sm font-medium">{acc.name}</p>
                    <p className="text-xs text-muted-foreground">Page ID: {acc.fbPageId} · {acc.fbApiVersion} · {acc.jobCount} jobs</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleValidate(acc.id)} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" title="Test connection">
                    <CheckCircle className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleDelete(acc.id)} className="rounded-lg p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Delete">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
