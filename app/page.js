"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "../lib/supabase";

const MODE_LABELS = {
  open: "営業中",
  away: "不在",
  closed: "休業",
  self_service: "セルフ貸出"
};

const VEHICLE_ORDER = { standard: 0, electric: 1, ypj: 2, scooter: 3 };
const ACCESSORY_ORDER = { child_seat: 0, helmet: 1 };

const MODE_HELP = {
  open: "通常営業。スタッフ対応を基本にします。",
  away: "スタッフ不在。セルフレンタル案内を自動化します。",
  closed: "臨時休業。セルフ貸出可能な場合のみ案内します。",
  self_service: "セルフ貸出を優先して自動案内します。"
};

export default function Home() {
  const supabase = useMemo(() => createClient(), []);
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profile, setProfile] = useState(null);
  const [settings, setSettings] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [accessories, setAccessories] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (typeof window !== "undefined" && window.location.hash.includes("type=recovery")) {
        setAuthMode("update");
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === "PASSWORD_RECOVERY") setAuthMode("update");
    });

    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (session && authMode !== "update") loadAll();
  }, [session, authMode]);

  async function signIn(e) {
    e.preventDefault();
    setBusy(true); setMessage("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage(error.message);
    else setAuthMode("login");
    setBusy(false);
  }

  async function sendReset(e) {
    e.preventDefault();
    setBusy(true); setMessage("");
    const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/` : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) setMessage(error.message);
    else setMessage("パスワード再設定メールを送信しました。メール内のリンクを開いてください。");
    setBusy(false);
  }

  async function updatePassword(e) {
    e.preventDefault();
    if (newPassword.length < 8) {
      setMessage("新しいパスワードは8文字以上にしてください。");
      return;
    }
    setBusy(true); setMessage("");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) setMessage(error.message);
    else {
      setMessage("パスワードを更新しました。管理画面へ移動します。");
      setAuthMode("login");
      if (typeof window !== "undefined") history.replaceState({}, document.title, window.location.pathname);
      await loadAll();
    }
    setBusy(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null); setSettings(null); setInventory([]); setAccessories([]);
    setAuthMode("login");
  }

  async function loadAll() {
    setBusy(true); setMessage("");
    const [profileRes, settingsRes, inventoryRes, accRes] = await Promise.all([
      supabase.from("user_profiles").select("display_name,role,active").single(),
      supabase.from("store_settings").select("*").limit(1).single(),
      supabase.from("self_service_inventory").select("id,enabled,available_quantity,reserved_quantity,vehicle_types(code,name_ja,name_en)").order("created_at"),
      supabase.from("rental_accessories").select("id,code,name_ja,name_en,self_service_enabled,available_quantity,reserved_quantity,price_yen").order("code")
    ]);
    if (profileRes.error) setMessage(profileRes.error.message);
    setProfile(profileRes.data || null);
    setSettings(settingsRes.data || null);
    const stableInventory = [...(inventoryRes.data || [])].sort(
      (a, b) => (VEHICLE_ORDER[a.vehicle_types?.code] ?? 99) - (VEHICLE_ORDER[b.vehicle_types?.code] ?? 99)
    );
    const stableAccessories = [...(accRes.data || [])].sort(
      (a, b) => (ACCESSORY_ORDER[a.code] ?? 99) - (ACCESSORY_ORDER[b.code] ?? 99)
    );
    setInventory(stableInventory);
    setAccessories(stableAccessories);
    setBusy(false);
  }

  async function setMode(mode) {
    const previous = settings;
    setSettings(prev => prev ? { ...prev, operation_mode: mode } : prev);
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("set_operation_mode", { p_mode: mode });
    if (error) {
      setSettings(previous);
      setMessage(error.message);
    }
    setBusy(false);
  }

  async function updateVehicle(row, patch) {
    const enabled = patch.enabled ?? row.enabled;
    const qty = Math.max(0, patch.available_quantity ?? row.available_quantity);
    const previous = inventory;
    setInventory(items => items.map(item =>
      item.id === row.id ? { ...item, enabled, available_quantity: qty } : item
    ));
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("set_self_inventory", {
      p_vehicle_type_code: row.vehicle_types.code,
      p_enabled: enabled,
      p_available_quantity: qty
    });
    if (error) {
      setInventory(previous);
      setMessage(error.message);
    }
    setBusy(false);
  }

  async function updateAccessory(row, patch) {
    const enabled = patch.self_service_enabled ?? row.self_service_enabled;
    const qty = Math.max(0, patch.available_quantity ?? row.available_quantity);
    const previous = accessories;
    setAccessories(items => items.map(item =>
      item.id === row.id ? { ...item, self_service_enabled: enabled, available_quantity: qty } : item
    ));
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("set_accessory_inventory", {
      p_code: row.code,
      p_enabled: enabled,
      p_available_quantity: qty
    });
    if (error) {
      setAccessories(previous);
      setMessage(error.message);
    }
    setBusy(false);
  }

  async function setAutoKeys(next) {
    const previous = settings;
    setSettings(prev => prev ? { ...prev, auto_release_keys: next } : prev);
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("set_auto_release_keys", { p_enabled: next });
    if (error) {
      setSettings(previous);
      setMessage(error.message);
    }
    setBusy(false);
  }

  if (authMode === "update") {
    return (
      <main className="shell narrow">
        <div className="brand">CHILL SPOT</div>
        <h1>新しいパスワード</h1>
        <p className="muted">新しいログインパスワードを設定してください。</p>
        <form onSubmit={updatePassword} className="card form">
          <label>新しいパスワード</label>
          <input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" minLength={8} required />
          <button className="primary" disabled={busy}>{busy ? "更新中…" : "パスワードを更新"}</button>
          {message && <p className={message.includes("更新しました") ? "success" : "error"}>{message}</p>}
        </form>
      </main>
    );
  }

  if (!session) {
    if (authMode === "forgot") {
      return (
        <main className="shell narrow">
          <div className="brand">CHILL SPOT</div>
          <h1>パスワード再設定</h1>
          <p className="muted">登録済みのメールアドレスへ再設定リンクを送ります。</p>
          <form onSubmit={sendReset} className="card form">
            <label>メールアドレス</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" required />
            <button className="primary" disabled={busy}>{busy ? "送信中…" : "再設定メールを送る"}</button>
            <button type="button" className="ghost" onClick={() => { setAuthMode("login"); setMessage(""); }}>ログインへ戻る</button>
            {message && <p className={message.includes("送信しました") ? "success" : "error"}>{message}</p>}
          </form>
        </main>
      );
    }

    return (
      <main className="shell narrow">
        <div className="brand">CHILL SPOT</div>
        <h1>管理画面ログイン</h1>
        <p className="muted">営業モード・無人貸出在庫をスマホから変更できます。</p>
        <form onSubmit={signIn} className="card form">
          <label>メールアドレス</label>
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" required />
          <label>パスワード</label>
          <input value={password} onChange={e => setPassword(e.target.value)} type="password" required />
          <button className="primary" disabled={busy}>{busy ? "ログイン中…" : "ログイン"}</button>
          <button type="button" className="linkbtn" onClick={() => { setAuthMode("forgot"); setMessage(""); }}>パスワードを忘れた場合</button>
          {message && <p className="error">{message}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand">CHILL SPOT</div>
          <h1>Self-Service Control</h1>
          <p className="muted">{profile?.display_name || "Staff"} / {profile?.role || "—"}</p>
        </div>
        <button className="ghost" onClick={signOut}>ログアウト</button>
      </header>

      {message && <div className="notice error">{message}</div>}

      <section className="card">
        <div className="section-title"><div><h2>店舗モード</h2><p className="muted">状況に合わせてワンタップで切り替え</p></div>{settings && <span className="status">{MODE_LABELS[settings.operation_mode]}</span>}</div>
        <div className="mode-grid">
          {Object.keys(MODE_LABELS).map(mode => (
            <button key={mode} disabled={busy} className={`mode ${settings?.operation_mode === mode ? "active" : ""}`} onClick={() => setMode(mode)}>
              <strong>{MODE_LABELS[mode]}</strong><span>{MODE_HELP[mode]}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title"><div><h2>無人貸出在庫</h2><p className="muted">その日にセルフ貸出へ回す台数だけ設定</p></div></div>
        <div className="rows">
          {inventory.map(row => (
            <div className="item" key={row.id}>
              <div className="item-main"><strong>{row.vehicle_types?.name_ja}</strong><span className="small">仮押さえ {row.reserved_quantity}</span></div>
              <div className="controls">
                <button className={`toggle ${row.enabled ? "on" : ""}`} onClick={() => updateVehicle(row, { enabled: !row.enabled })}>{row.enabled ? "ON" : "OFF"}</button>
                <div className="stepper"><button onClick={() => updateVehicle(row, { available_quantity: row.available_quantity - 1 })}>−</button><strong>{row.available_quantity}</strong><button onClick={() => updateVehicle(row, { available_quantity: row.available_quantity + 1 })}>＋</button></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title"><div><h2>オプション</h2><p className="muted">貸し出せる日のみON</p></div></div>
        <div className="rows">
          {accessories.map(row => (
            <div className="item" key={row.id}>
              <div className="item-main"><strong>{row.name_ja}</strong><span className="small">仮押さえ {row.reserved_quantity}</span></div>
              <div className="controls">
                <button className={`toggle ${row.self_service_enabled ? "on" : ""}`} onClick={() => updateAccessory(row, { self_service_enabled: !row.self_service_enabled })}>{row.self_service_enabled ? "ON" : "OFF"}</button>
                <div className="stepper"><button onClick={() => updateAccessory(row, { available_quantity: row.available_quantity - 1 })}>−</button><strong>{row.available_quantity}</strong><button onClick={() => updateAccessory(row, { available_quantity: row.available_quantity + 1 })}>＋</button></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title"><div><h2>安全設定</h2><p className="muted">鍵の自動案内はテスト完了後にON推奨</p></div></div>
        <div className="item">
          <div className="item-main"><strong>決済後の鍵自動案内</strong><span className="small">Adminのみ変更可能</span></div>
          <button className={`toggle ${settings?.auto_release_keys ? "on danger" : ""}`} disabled={profile?.role !== "admin" || busy} onClick={() => setAutoKeys(!settings?.auto_release_keys)}>{settings?.auto_release_keys ? "ON" : "OFF"}</button>
        </div>
      </section>

      <footer><button className="ghost" onClick={loadAll} disabled={busy}>{busy ? "更新中…" : "最新状態を再読込"}</button></footer>
    </main>
  );
}
