// supabase/functions/convert-to-cad/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// use your env secrets instead of hard-coding URLs
const MASK_URL = Deno.env.get("MASK_SERVICE_URL")!;
const CAD_URL  = Deno.env.get("CAD_SERVICE_URL")!;

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method Not Allowed" }),
      { status: 405, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  let body: { conversionId: string; userId: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON" }),
      { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  const { conversionId, userId } = body;
  console.log("🔄 convert-to-cad called for", conversionId);

  try {
    // 1) Validate conversion record exists
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("cad_conversions")
      .select("*")
      .eq("id", conversionId)
      .single();
    if (convErr || !conv) throw new Error("Conversion not found");

    // 2) Fetch the vector SVG URL from your previous step
    const svgUrl = conv.vectorized_svg_url;
    if (!svgUrl) throw new Error("No vector SVG URL on conversion");

    // 3) Update status → generating_cad
    await supabaseAdmin
      .from("cad_conversions")
      .update({ status: "generating_cad", current_step: 3 })
      .eq("id", conversionId);

    // 4) Load specs from your tables
    const { data: gemSpecs } = await supabaseAdmin
      .from("gemstone_specs")
      .select("*")
      .eq("conversion_id", conversionId);
    const { data: metalSpecs } = await supabaseAdmin
      .from("metal_specs")
      .select("*")
      .eq("conversion_id", conversionId)
      .single();
    if (!metalSpecs) throw new Error("Missing metal specs");

    // 5) Call your Cloud Run CAD service
    const cadReq = {
      svg_url: svgUrl,
      design_id: conversionId,
      gemstone_specs: gemSpecs?.map((g) => ({
        shape: g.shape,
        size_mm: Number(g.mm_size),
        dia_wt: Number(g.dia_wt),
        quantity: g.quantity,
        setting_type: g.setting_type,
      })) || [],
      metal_specs: {
        type: metalSpecs.color,
        karat: metalSpecs.karat,
        weight_grams: Number(metalSpecs.gold_weight),
        tone: metalSpecs.tone,
      },
    };

    console.log("➡️ Calling CAD service", CAD_URL);
    const cadResp = await fetch(${CAD_URL}/convert, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cadReq),
      signal: AbortSignal.timeout(300_000),
    });
    if (!cadResp.ok) {
      const txt = await cadResp.text();
      throw new Error(CAD service error: ${txt});
    }
    const cadJson = await cadResp.json();

    // 6) Upload returned files to your storage bucket
    const bucket = supabaseAdmin.storage.from("cad-files");
    // STEP
    await bucket.upload(step/design_${conversionId}.step, new Blob([cadJson.step_file]), {
      contentType: "model/step",
      upsert: true,
    });
    // STL
    await bucket.upload(stl/design_${conversionId}.stl, new Blob([cadJson.stl_file]), {
      contentType: "model/stl",
      upsert: true,
    });
    // OBJ
    await bucket.upload(obj/design_${conversionId}.obj, new Blob([cadJson.obj_file]), {
      contentType: "model/obj",
      upsert: true,
    });

    // 7) Get public URLs
    const stepUrl = bucket.getPublicUrl(step/design_${conversionId}.step).data.publicUrl;
    const stlUrl  = bucket.getPublicUrl(stl/design_${conversionId}.stl).data.publicUrl;
    const objUrl  = bucket.getPublicUrl(obj/design_${conversionId}.obj).data.publicUrl;

    // 8) Finalize in DB
    await supabaseAdmin
      .from("cad_conversions")
      .update({
        status: "completed",
        current_step: 4,
        cad_file_url: stepUrl,
        stl_file_url: stlUrl,
        obj_file_url: objUrl,
        completed_at: new Date().toISOString(),
      })
      .eq("id", conversionId);

    console.log("✅ CAD conversion completed:", conversionId);
    return new Response(
      JSON.stringify({ success: true, conversionId }),
      { status: 200, headers: CORS }
    );

  } catch (err) {
    console.error("❌ convert-to-cad failed:", err);
    // Mark as failed
    if (conversionId) {
      await supabaseAdmin
        .from("cad_conversions")
        .update({ status: "failed", current_step: 0, error_message: String(err) })
        .eq("id", conversionId);
    }
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
