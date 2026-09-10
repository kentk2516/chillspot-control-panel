export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    return Response.json({
      ok: false,
      stage: "env",
      message: "Missing Supabase environment variables",
      hasUrl: Boolean(url),
      hasKey: Boolean(key)
    }, { status: 500 });
  }

  try {
    const host = new URL(url).host;
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`
      },
      cache: "no-store"
    });

    const text = await res.text();

    return Response.json({
      ok: res.ok,
      stage: "supabase",
      host,
      status: res.status,
      bodyPreview: text.slice(0, 200)
    }, { status: res.ok ? 200 : 502 });
  } catch (error) {
    return Response.json({
      ok: false,
      stage: "network",
      message: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}
