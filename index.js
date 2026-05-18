"use client";

import { useEffect, useMemo, useState } from "react";
import supabase from "../lib/supabase";

const WA_ENGINE_URL = "https://wa-engine-production-8ebe.up.railway.app";
const ANSWER_SEPARATOR = "\n---JAWABAN_BARU---\n";

export default function Home() {
  const [flows, setFlows] = useState([]);
  const [allTriggers, setAllTriggers] = useState([]);
  const [selectedFlow, setSelectedFlow] = useState(null);
  const [templateSelectedFlow, setTemplateSelectedFlow] = useState(null);

  const [newFlowName, setNewFlowName] = useState("");
  const [editingFlowId, setEditingFlowId] = useState(null);
  const [editingFlowName, setEditingFlowName] = useState("");

  const [checkoutEditingFlowId, setCheckoutEditingFlowId] = useState(null);
  const [checkoutForm, setCheckoutForm] = useState({
    enabled: false,
    productName: "",
    price1: "",
    price2: "",
    priceExtra: "",
    defaultShipping: "",
    shippingByAreaText: "",
  });

  const [copyTargetFlow, setCopyTargetFlow] = useState({});
  const [copyingTriggerId, setCopyingTriggerId] = useState(null);

  const [keyword, setKeyword] = useState("");
  const [response, setResponse] = useState("");
  const [responseList, setResponseList] = useState([""]);
  const [type, setType] = useState("Mengandung");
  const [image, setImage] = useState("");
  const [media, setMedia] = useState([]);
  const [mediaAnswerIndex, setMediaAnswerIndex] = useState(0);
  const [followups, setFollowups] = useState([
    {
      delayMinutes: 5,
      message: "",
      active: true,
    },
  ]);
  const [isFlowEntry, setIsFlowEntry] = useState(false);

  const [editingTriggerId, setEditingTriggerId] = useState(null);
  const [editKeyword, setEditKeyword] = useState("");
  const [editResponse, setEditResponse] = useState("");
  const [editResponseList, setEditResponseList] = useState([""]);
  const [editType, setEditType] = useState("Mengandung");
  const [editIsFlowEntry, setEditIsFlowEntry] = useState(false);
  const [editImage, setEditImage] = useState("");
  const [editMedia, setEditMedia] = useState([]);
  const [editMediaAnswerIndex, setEditMediaAnswerIndex] = useState(0);
  const [editFollowups, setEditFollowups] = useState([
    {
      delayMinutes: 5,
      message: "",
      active: true,
    },
  ]);

  const [activeMenu, setActiveMenu] = useState("perangkat");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [uploadingCount, setUploadingCount] = useState(0);
  const [editUploadingCount, setEditUploadingCount] = useState(0);

  const [waStatus, setWaStatus] = useState(null);
  const [qrData, setQrData] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrMessage, setQrMessage] = useState("");
  const [qrFrameKey, setQrFrameKey] = useState(Date.now());

  const uploading = uploadingCount > 0;
  const editUploading = editUploadingCount > 0;


  const totalActiveTriggers = useMemo(
    () => allTriggers.filter((item) => item.active).length,
    [allTriggers]
  );

  function joinResponses(list) {
    return list
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join(ANSWER_SEPARATOR);
  }

  function splitResponses(value) {
    const raw = String(value || "");

    // Format baru: jawaban dipisah pakai separator khusus.
    // Enter biasa di dalam textarea tetap dianggap bagian dari 1 jawaban.
    if (raw.includes(ANSWER_SEPARATOR.trim())) {
      const result = raw
        .split(ANSWER_SEPARATOR.trim())
        .map((item) => item.trim())
        .filter(Boolean);

      return result.length > 0 ? result : [""];
    }

    // Legacy: data lama masih pakai newline sebagai pemisah.
    // Ini hanya untuk trigger lama yang belum disimpan ulang.
    const result = raw
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);

    return result.length > 0 ? result : [""];
  }

  function getResponseParts(value) {
    return splitResponses(value);
  }

  function getMediaFromItem(item) {
    if (Array.isArray(item?.media)) {
      return item.media.filter((m) => m?.url);
    }

    if (typeof item?.media === "string") {
      try {
        const parsed = JSON.parse(item.media);
        if (Array.isArray(parsed)) {
          return parsed.filter((m) => m?.url);
        }
      } catch {}
    }

    if (item?.image) {
      return [{ type: "image", url: item.image }];
    }

    return [];
  }

  function getMediaSummary(item) {
    const list = getMediaFromItem(item);
    const imageCount = list.filter((m) => m.type !== "video").length;
    const videoCount = list.filter((m) => m.type === "video").length;

    if (imageCount > 0 && videoCount > 0) return `${imageCount} foto · ${videoCount} video`;
    if (imageCount > 0) return `${imageCount} foto`;
    if (videoCount > 0) return `${videoCount} video`;
    return "Tanpa media";
  }

  function getMediaAnswerIndex(item) {
    const value = Number(item?.responseIndex);

    if (Number.isInteger(value) && value >= 0) {
      return value;
    }

    return 0;
  }

  function getMediaLabel(item) {
    return `Jawaban ${getMediaAnswerIndex(item) + 1}`;
  }

  function getFollowupsFromItem(item) {
    if (Array.isArray(item?.followups)) {
      return item.followups;
    }

    if (typeof item?.followups === "string") {
      try {
        const parsed = JSON.parse(item.followups);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {}
    }

    return [];
  }

  function normalizeFollowups(list) {
    return list
      .map((item) => ({
        delayMinutes: Number(item.delayMinutes) > 0 ? Number(item.delayMinutes) : 1,
        message: String(item.message || "").trim(),
        active: item.active !== false,
      }))
      .filter((item) => item.message);
  }

  function updateFollowupValue(index, field, value, mode = "create") {
    const setter = mode === "edit" ? setEditFollowups : setFollowups;
    const source = mode === "edit" ? editFollowups : followups;

    const updated = [...source];
    updated[index] = {
      ...updated[index],
      [field]: value,
    };

    setter(updated);
  }

  function addFollowup(mode = "create") {
    const setter = mode === "edit" ? setEditFollowups : setFollowups;
    const source = mode === "edit" ? editFollowups : followups;

    setter([
      ...source,
      {
        delayMinutes: 5,
        message: "",
        active: true,
      },
    ]);
  }

  function getCheckoutFromFlow(flow) {
    if (!flow?.checkout) return {};

    if (typeof flow.checkout === "string") {
      try {
        return JSON.parse(flow.checkout) || {};
      } catch {
        return {};
      }
    }

    return flow.checkout || {};
  }

  function shippingByAreaToText(value) {
    return Object.entries(value || {})
      .map(([area, price]) => `${area}=${price}`)
      .join("\n");
  }

  function textToShippingByArea(value) {
    const result = {};

    String(value || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const [areaRaw, priceRaw] = line.split("=");
        const area = String(areaRaw || "").trim().toLowerCase();
        const price = Number(String(priceRaw || "").replace(/[^0-9]/g, ""));

        if (area && price > 0) result[area] = price;
      });

    return result;
  }

  function startEditCheckout(flow) {
    const checkout = getCheckoutFromFlow(flow);

    setCheckoutEditingFlowId(flow.id);
    setCheckoutForm({
      enabled: checkout.enabled === true,
      productName: checkout.productName || flow.name || "",
      price1: checkout.price1 || "",
      price2: checkout.price2 || "",
      priceExtra: checkout.priceExtra || "",
      defaultShipping: checkout.defaultShipping || "",
      shippingByAreaText: shippingByAreaToText(checkout.shippingByArea),
    });
  }

  async function saveCheckout(flowId) {
    const checkout = {
      enabled: checkoutForm.enabled === true,
      productName: String(checkoutForm.productName || "").trim(),
      price1: Number(checkoutForm.price1) || 0,
      price2: Number(checkoutForm.price2) || 0,
      priceExtra: Number(checkoutForm.priceExtra) || 0,
      defaultShipping: Number(checkoutForm.defaultShipping) || 0,
      shippingByArea: textToShippingByArea(checkoutForm.shippingByAreaText),
    };

    const { error } = await supabase
      .from("flows")
      .update({ checkout })
      .eq("id", flowId);

    if (error) {
      alert(error.message || "Gagal simpan checkout");
      return;
    }

    setCheckoutEditingFlowId(null);
    await refreshAll();
    alert("Setting checkout berhasil disimpan");
  }

  function removeFollowup(index, mode = "create") {
    const setter = mode === "edit" ? setEditFollowups : setFollowups;
    const source = mode === "edit" ? editFollowups : followups;
    const updated = source.filter((_, i) => i !== index);

    setter(
      updated.length > 0
        ? updated
        : [
            {
              delayMinutes: 5,
              message: "",
              active: true,
            },
          ]
    );
  }

  async function getFlows() {
    const { data } = await supabase
      .from("flows")
      .select("*")
      .order("id", { ascending: false });

    const flowData = data || [];
    setFlows(flowData);

    if (!selectedFlow && flowData.length > 0) {
      setSelectedFlow(flowData[0]);
    }
  }

  async function getAllTriggers() {
    const { data } = await supabase
      .from("triggers")
      .select("*")
      .order("id", { ascending: false });

    setAllTriggers(data || []);
  }

  async function refreshAll() {
    await getFlows();
    await getAllTriggers();
  }

  async function addFlow() {
    if (!newFlowName) return alert("Isi nama alur");

    await supabase.from("flows").insert([{ name: newFlowName }]);

    setNewFlowName("");
    refreshAll();
  }

  async function updateFlowName(id) {
    if (!editingFlowName) return alert("Nama alur tidak boleh kosong");

    await supabase.from("flows").update({ name: editingFlowName }).eq("id", id);

    if (selectedFlow?.id === id) {
      setSelectedFlow({ ...selectedFlow, name: editingFlowName });
    }

    setEditingFlowId(null);
    setEditingFlowName("");
    refreshAll();
  }

  async function deleteFlow(id) {
  const ok = confirm(
    "Yakin hapus alur? Semua trigger dan session di alur ini ikut terhapus."
  );

  if (!ok) return;

  try {
    const sessionDelete = await supabase
      .from("sessions")
      .delete()
      .eq("flow_id", id);

    if (sessionDelete.error) {
      alert(sessionDelete.error.message);
      return;
    }

    const triggerDelete = await supabase
      .from("triggers")
      .delete()
      .eq("flow_id", id);

    if (triggerDelete.error) {
      alert(triggerDelete.error.message);
      return;
    }

    const flowDelete = await supabase
      .from("flows")
      .delete()
      .eq("id", id);

    if (flowDelete.error) {
      alert(flowDelete.error.message);
      return;
    }

    if (selectedFlow?.id === id) {
      setSelectedFlow(null);
    }

    if (templateSelectedFlow?.id === id) {
      setTemplateSelectedFlow(null);
    }

    refreshAll();
  } catch (err) {
    alert(err.message);
  }
}
  function selectFlow(flow) {
    setSelectedFlow(flow);
    setShowCreateForm(false);
    setEditingTriggerId(null);
    setCopyingTriggerId(null);
  }

  async function getWaStatus() {
    try {
      const res = await fetch(`${WA_ENGINE_URL}/qr-json?t=${Date.now()}`, {
        cache: "no-store",
        mode: "cors",
      });

      const data = await res.json();

      setWaStatus(data.connected);

      if (data.connected) {
        setQrData(null);
        setQrLoading(false);
        setQrMessage("WhatsApp sudah terhubung.");
      } else {
        setQrData(data.qr || null);

        if (data.qr) {
          setQrLoading(false);
          setQrMessage("QR siap discan.");
        }
      }

      return data;
    } catch (err) {
      setWaStatus(false);
      return null;
    }
  }

  async function connectWa() {
    setShowQr(true);
    setQrLoading(true);
    setQrData(null);
    setWaStatus(false);
    setQrMessage("Membuka QR dari WA Engine...");
    setQrFrameKey(Date.now());

    try {
      await fetch(`${WA_ENGINE_URL}/connect?t=${Date.now()}`, {
        cache: "no-store",
        mode: "no-cors",
      });
    } catch {}

    setTimeout(() => {
      setQrFrameKey(Date.now());
      setQrLoading(false);
      setQrMessage(
        "QR ditampilkan dari WA Engine. Kalau belum muncul, klik Buka QR Langsung."
      );
      getWaStatus();
    }, 3500);
  }

  async function logoutWa() {
    const ok = confirm("Nonaktifkan / logout WhatsApp?");
    if (!ok) return;

    try {
      await fetch(`${WA_ENGINE_URL}/logout?t=${Date.now()}`, {
        cache: "no-store",
        mode: "no-cors",
      });
    } catch {}

    setShowQr(false);
    setQrLoading(false);
    setQrData(null);
    setQrMessage("");
    setQrFrameKey(Date.now());
    setWaStatus(false);

    setTimeout(getWaStatus, 2000);
  }

  useEffect(() => {
    refreshAll();
    getWaStatus();

    const interval = setInterval(getWaStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  async function uploadMedia(file, responseIndex = 0) {
    setUploadingCount((prev) => prev + 1);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(text || "Server tidak mengembalikan JSON");
      }

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Upload gagal");
      }

      const url = data.url || data.image;

      setMedia((prev) => [
        ...prev,
        {
          type: data.type || (file.type.startsWith("video/") ? "video" : "image"),
          url,
          responseIndex,
        },
      ]);

      if (data.type === "image" && !image) {
        setImage(url);
      }
    } catch (err) {
      alert("Upload gagal: " + err.message);
    } finally {
      setUploadingCount((prev) => Math.max(prev - 1, 0));
    }
  }

  async function uploadEditMedia(file, responseIndex = 0) {
    setEditUploadingCount((prev) => prev + 1);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(text || "Server tidak mengembalikan JSON");
      }

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Upload gagal");
      }

      const url = data.url || data.image;

      setEditMedia((prev) => [
        ...prev,
        {
          type: data.type || (file.type.startsWith("video/") ? "video" : "image"),
          url,
          responseIndex,
        },
      ]);

      if (data.type === "image" && !editImage) {
        setEditImage(url);
      }
    } catch (err) {
      alert("Upload gagal: " + err.message);
    } finally {
      setEditUploadingCount((prev) => Math.max(prev - 1, 0));
    }
  }

  function removeMedia(index) {
    const updated = media.filter((_, i) => i !== index);
    setMedia(updated);

    const firstImage = updated.find((m) => m.type === "image");
    setImage(firstImage?.url || "");
  }

  function removeEditMedia(index) {
    const updated = editMedia.filter((_, i) => i !== index);
    setEditMedia(updated);

    const firstImage = updated.find((m) => m.type === "image");
    setEditImage(firstImage?.url || "");
  }

  async function addTrigger() {
    if (!selectedFlow) return alert("Pilih alur dulu");

    if (uploading) {
      return alert("Tunggu upload selesai dulu");
    }

    const finalResponse = joinResponses(responseList);

    if (!keyword || (!finalResponse && media.length === 0)) {
      return alert("Isi keyword dan respon/foto/video");
    }

    const firstImage = media.find((m) => m.type === "image");

    await supabase.from("triggers").insert([
      {
        flow_id: selectedFlow.id,
        keyword,
        response: finalResponse,
        type,
        image: firstImage?.url || "",
        media,
        followups: normalizeFollowups(followups),
        active: true,
        is_flow_entry: isFlowEntry,
      },
    ]);

    setKeyword("");
    setResponse("");
    setResponseList([""]);
    setType("Mengandung");
    setImage("");
    setMedia([]);
    setMediaAnswerIndex(0);
    setFollowups([
      {
        delayMinutes: 5,
        message: "",
        active: true,
      },
    ]);
    setIsFlowEntry(false);
    setShowCreateForm(false);
    setUploadingCount(0);

    getAllTriggers();
  }

  function startEditTrigger(item) {
    const itemMedia = getMediaFromItem(item);
    const firstImage = itemMedia.find((m) => m.type === "image");

    setEditingTriggerId(item.id);
    setEditKeyword(item.keyword || "");
    setEditResponse(item.response || "");
    setEditResponseList(splitResponses(item.response));
    setEditType(item.type || "Mengandung");
    setEditIsFlowEntry(item.is_flow_entry === true);
    setEditMedia(itemMedia);
    setEditMediaAnswerIndex(0);
    setEditFollowups(
      getFollowupsFromItem(item).length > 0
        ? getFollowupsFromItem(item)
        : [
            {
              delayMinutes: 5,
              message: "",
              active: true,
            },
          ]
    );
    setEditImage(firstImage?.url || item.image || "");
  }

  async function saveEditTrigger(id) {
    if (editUploading) {
      return alert("Tunggu upload selesai dulu");
    }

    const finalEditResponse = joinResponses(editResponseList);

    if (!editKeyword || (!finalEditResponse && editMedia.length === 0)) {
      return alert("Keyword dan respon/foto/video tidak boleh kosong");
    }

    const firstImage = editMedia.find((m) => m.type === "image");

    await supabase
      .from("triggers")
      .update({
        keyword: editKeyword,
        response: finalEditResponse,
        type: editType,
        image: firstImage?.url || "",
        media: editMedia,
        followups: normalizeFollowups(editFollowups),
        is_flow_entry: editIsFlowEntry,
      })
      .eq("id", id);

    setEditingTriggerId(null);
    setEditKeyword("");
    setEditResponse("");
    setEditResponseList([""]);
    setEditType("Mengandung");
    setEditIsFlowEntry(false);
    setEditImage("");
    setEditMedia([]);
    setEditMediaAnswerIndex(0);
    setEditFollowups([
      {
        delayMinutes: 5,
        message: "",
        active: true,
      },
    ]);
    setEditUploadingCount(0);

    getAllTriggers();
  }

  async function duplicateTrigger(item, targetFlowId = null) {
    try {
      const targetFlow = targetFlowId || item.flow_id;

      const payload = {
        flow_id: targetFlow,
        keyword: `${item.keyword} copy`,
        response: item.response || "",
        type: item.type || "Mengandung",
        image: item.image || "",
        media: item.media || [],
        followups: getFollowupsFromItem(item),
        active: true,
        is_flow_entry: item.is_flow_entry === true,
      };

      const { data, error } = await supabase
        .from("triggers")
        .insert([payload])
        .select()
        .single();

      if (error) {
        alert(error.message || "Gagal copy trigger");
        return;
      }

      await getAllTriggers();

      if (data) {
        const targetFlowData = flows.find((flow) => flow.id === targetFlow);
        if (targetFlowData) setSelectedFlow(targetFlowData);
        startEditTrigger(data);
      }

      alert("Trigger berhasil disalin");
    } catch (err) {
      alert("Gagal duplicate: " + err.message);
    }
  }

  async function toggleStatus(id, current) {
    await supabase.from("triggers").update({ active: !current }).eq("id", id);
    getAllTriggers();
  }

  async function deleteTrigger(id) {
    const ok = confirm("Yakin hapus trigger ini?");
    if (!ok) return;

    await supabase.from("triggers").delete().eq("id", id);
    getAllTriggers();
  }

  const styles = {
    page: {
      minHeight: "100vh",
      color: "white",
      padding: 24,
    },
    shell: {
      display: "grid",
      gridTemplateColumns: "240px minmax(0, 1fr)",
      gap: 22,
      maxWidth: 1480,
      margin: "0 auto",
    },
    sidebar: {
      position: "sticky",
      top: 24,
      height: "calc(100vh - 48px)",
      padding: 18,
      overflow: "auto",
    },
    logo: {
      width: 46,
      height: 46,
      borderRadius: 17,
      display: "grid",
      placeItems: "center",
      background: "linear-gradient(135deg, #00ff9d, #00b871)",
      color: "#001b12",
      fontWeight: 950,
      boxShadow: "0 0 28px rgba(0,255,157,0.28)",
    },
    muted: {
      color: "#8c929c",
    },
    input: {
      width: "100%",
      background: "rgba(255,255,255,0.055)",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "white",
      borderRadius: 15,
      padding: "13px 14px",
      outline: "none",
    },
    textarea: {
      width: "100%",
      minHeight: 90,
      resize: "vertical",
      background: "rgba(255,255,255,0.055)",
      border: "1px solid rgba(255,255,255,0.1)",
      color: "white",
      borderRadius: 15,
      padding: 14,
      outline: "none",
      lineHeight: 1.6,
    },
    button: {
      border: "none",
      borderRadius: 14,
      padding: "11px 14px",
      cursor: "pointer",
      fontWeight: 800,
    },
    ghostButton: {
      background: "rgba(255,255,255,0.065)",
      color: "white",
      border: "1px solid rgba(255,255,255,0.08)",
    },
    dangerButton: {
      background: "rgba(255,77,103,0.14)",
      color: "#ff7b90",
      border: "1px solid rgba(255,77,103,0.24)",
    },
    section: {
      padding: 24,
      marginBottom: 22,
    },
    label: {
      display: "block",
      fontSize: 13,
      color: "#8c929c",
      marginBottom: 8,
      fontWeight: 800,
    },
    pill: {
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      padding: "7px 12px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 850,
    },
  };

  function SidebarButton({ id, label, icon }) {
    const active = activeMenu === id;

    return (
      <button
        onClick={() => {
          setActiveMenu(id);
          if (id === "template") {
            setTemplateSelectedFlow(null);
            setShowCreateForm(false);
            setEditingTriggerId(null);
          }
        }}
        className="sidebar-item"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "13px 14px",
          borderRadius: 16,
          marginBottom: 10,
          cursor: "pointer",
          color: active ? "#00ff9d" : "white",
          background: active
            ? "linear-gradient(135deg, rgba(0,255,157,0.16), rgba(255,255,255,0.045))"
            : "rgba(255,255,255,0.035)",
          border: active
            ? "1px solid rgba(0,255,157,0.26)"
            : "1px solid rgba(255,255,255,0.055)",
          textAlign: "left",
          fontWeight: 850,
        }}
      >
        <span style={{ width: 22, textAlign: "center" }}>{icon}</span>
        {label}
      </button>
    );
  }

  function Header({ title, description }) {
    return (
      <div
        className="glass-card"
        style={{
          ...styles.section,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 18,
          background:
            "linear-gradient(135deg, rgba(255,255,255,0.07), rgba(0,255,157,0.035))",
        }}
      >
        <div>
          <p
            style={{
              color: "#00ff9d",
              fontSize: 12,
              fontWeight: 950,
              letterSpacing: 1.8,
              marginBottom: 9,
            }}
          >
            NEXIS
          </p>
          <h1
            style={{
              fontSize: 38,
              letterSpacing: -1.6,
              marginBottom: 8,
              lineHeight: 1,
            }}
          >
            {title}
          </h1>
          <p style={{ ...styles.muted, lineHeight: 1.7 }}>{description}</p>
        </div>

        <span
          style={{
            ...styles.pill,
            background: waStatus ? "rgba(0,255,157,0.12)" : "rgba(255,77,103,0.12)",
            color: waStatus ? "#00ff9d" : "#ff7b90",
            border: waStatus
              ? "1px solid rgba(0,255,157,0.2)"
              : "1px solid rgba(255,77,103,0.2)",
          }}
        >
          ● {waStatus ? "Terhubung" : "Tidak Terhubung"}
        </span>
      </div>
    );
  }

  function DevicePage() {
    return (
      <>
        {Header({
          title: "Perangkat",
          description: "Kelola koneksi WhatsApp, aktifkan/nonaktifkan device, dan tampilkan QR untuk scan.",
        })}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 360px",
            gap: 22,
          }}
        >
          <div className="glass-card" style={styles.section}>
            <div
              style={{
                padding: 22,
                borderRadius: 26,
                background:
                  "linear-gradient(135deg, rgba(0,255,157,0.10), rgba(255,255,255,0.035))",
                border: "1px solid rgba(0,255,157,0.14)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 18,
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <p style={styles.muted}>Card Perangkat</p>
                  <h2 style={{ marginTop: 8, fontSize: 30, letterSpacing: -0.8 }}>
                    WhatsApp Utama
                  </h2>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      marginTop: 14,
                    }}
                  >
                    <span
                      style={{
                        width: 11,
                        height: 11,
                        borderRadius: 999,
                        background: waStatus ? "#00ff9d" : "#ff4d67",
                        boxShadow: waStatus
                          ? "0 0 18px rgba(0,255,157,0.75)"
                          : "0 0 18px rgba(255,77,103,0.75)",
                      }}
                    />
                    <b>{waStatus ? "Terhubung" : "Tidak Terhubung"}</b>
                  </div>

                  <p style={{ ...styles.muted, marginTop: 12, lineHeight: 1.7 }}>
                    Perangkat ini digunakan untuk menerima pesan masuk dan mengirim
                    auto reply dari template yang sudah dibuat.
                  </p>
                </div>

                <div
                  style={{
                    width: 78,
                    height: 78,
                    borderRadius: 26,
                    display: "grid",
                    placeItems: "center",
                    background: "rgba(0,255,157,0.10)",
                    border: "1px solid rgba(0,255,157,0.16)",
                    fontSize: 32,
                  }}
                >
                  ☎
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 24 }}>
                {!waStatus ? (
                  <button onClick={connectWa} className="green-btn" style={styles.button}>
                    Aktifkan
                  </button>
                ) : (
                  <button onClick={logoutWa} style={{ ...styles.button, ...styles.dangerButton }}>
                    Nonaktifkan
                  </button>
                )}

                <button
                  onClick={() => {
                    if (showQr) {
                      setShowQr(false);
                      setQrLoading(false);
                      setQrMessage("");
                      return;
                    }

                    connectWa();
                  }}
                  style={{ ...styles.button, ...styles.ghostButton }}
                >
                  {showQr ? "Tutup QR" : "Scan QR"}
                </button>
              </div>
            </div>
          </div>

          <div className="glass-card" style={styles.section}>
            <p style={styles.muted}>QR Scan</p>
            <h3 style={{ marginTop: 8 }}>Barcode Perangkat</h3>

            {showQr ? (
              <div
                style={{
                  marginTop: 18,
                  padding: 14,
                  borderRadius: 24,
                  background: "rgba(255,255,255,0.07)",
                }}
              >
                <iframe
                  key={qrFrameKey}
                  src={`${WA_ENGINE_URL}/qr?t=${qrFrameKey}`}
                  title="QR WhatsApp"
                  style={{
                    width: "100%",
                    height: 340,
                    border: "none",
                    borderRadius: 18,
                    background: "white",
                    display: "block",
                  }}
                />

                <p
                  style={{
                    ...styles.muted,
                    marginTop: 12,
                    textAlign: "center",
                    fontSize: 13,
                    lineHeight: 1.6,
                  }}
                >
                  {qrLoading
                    ? "Sedang membuka QR dari WA Engine..."
                    : qrMessage ||
                      "Scan QR ini dari WhatsApp. Jika belum muncul, buka QR langsung."}
                </p>

                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    justifyContent: "center",
                    flexWrap: "wrap",
                    marginTop: 12,
                  }}
                >
                  <button
                    onClick={() => {
                      setQrFrameKey(Date.now());
                      connectWa();
                    }}
                    className="green-btn"
                    style={{
                      ...styles.button,
                      padding: "9px 13px",
                    }}
                  >
                    Refresh QR
                  </button>

                  <a
                    href={`${WA_ENGINE_URL}/qr?t=${Date.now()}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      ...styles.button,
                      ...styles.ghostButton,
                      display: "inline-block",
                      textDecoration: "none",
                      padding: "9px 13px",
                    }}
                  >
                    Buka QR Langsung
                  </a>

                  <a
                    href={`${WA_ENGINE_URL}/connect?t=${Date.now()}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      ...styles.button,
                      ...styles.ghostButton,
                      display: "inline-block",
                      textDecoration: "none",
                      padding: "9px 13px",
                    }}
                  >
                    Restart Session
                  </a>
                </div>
              </div>
            ) : (
              <div
                style={{
                  marginTop: 18,
                  minHeight: 280,
                  borderRadius: 24,
                  display: "grid",
                  placeItems: "center",
                  textAlign: "center",
                  padding: 24,
                  background: "rgba(255,255,255,0.035)",
                  border: "1px dashed rgba(255,255,255,0.12)",
                }}
              >
                <div>
                  <p style={{ fontSize: 34, marginBottom: 12 }}>▦</p>
                  <p style={styles.muted}>
                    Klik Scan QR untuk membuka barcode perangkat.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  function FlowCard({ flow }) {
    const flowTriggers = allTriggers.filter((item) => item.flow_id === flow.id);
    const isSelected = selectedFlow?.id === flow.id;

    return (
      <div
        style={{
          borderRadius: 28,
          background: isSelected
            ? "linear-gradient(135deg, rgba(0,255,157,0.13), rgba(255,255,255,0.04))"
            : "rgba(255,255,255,0.035)",
          border: isSelected
            ? "1px solid rgba(0,255,157,0.22)"
            : "1px solid rgba(255,255,255,0.07)",
          padding: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 14,
            marginBottom: 18,
          }}
        >
          <div>
            {editingFlowId === flow.id ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={editingFlowName}
                  onChange={(e) => setEditingFlowName(e.target.value)}
                  style={{ ...styles.input, minWidth: 240 }}
                />
                <button
                  onClick={() => updateFlowName(flow.id)}
                  className="green-btn"
                  style={styles.button}
                >
                  Simpan
                </button>
                <button
                  onClick={() => {
                    setEditingFlowId(null);
                    setEditingFlowName("");
                  }}
                  style={{ ...styles.button, ...styles.ghostButton }}
                >
                  Batal
                </button>
              </div>
            ) : (
              <>
                <p style={styles.muted}>Template Alur</p>
                <h2 style={{ marginTop: 7, fontSize: 26, letterSpacing: -0.7 }}>
                  {flow.name}
                </h2>
                <p style={{ ...styles.muted, marginTop: 7 }}>
                  {flowTriggers.length} trigger tersimpan
                </p>
              </>
            )}
          </div>

          {editingFlowId !== flow.id && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  selectFlow(flow);
                  setShowCreateForm(!showCreateForm || selectedFlow?.id !== flow.id);
                }}
                className="green-btn"
                style={styles.button}
              >
                + Trigger
              </button>

              <button
                onClick={() => {
                  setEditingFlowId(flow.id);
                  setEditingFlowName(flow.name);
                }}
                style={{ ...styles.button, ...styles.ghostButton }}
              >
                Edit Alur
              </button>

              <button
                onClick={() => deleteFlow(flow.id)}
                style={{ ...styles.button, ...styles.dangerButton }}
              >
                Hapus
              </button>
            </div>
          )}
        </div>

        {showCreateForm && selectedFlow?.id === flow.id && (
          <div style={{ marginBottom: 18 }}>
            {CreateTriggerBox()}
          </div>
        )}

        <div style={{ display: "grid", gap: 14 }}>
          {flowTriggers.map((trigger) => (
            <div key={trigger.id}>{TriggerCard({ item: trigger })}</div>
          ))}

          {flowTriggers.length === 0 && (
            <div
              style={{
                padding: 22,
                borderRadius: 22,
                background: "rgba(255,255,255,0.03)",
                border: "1px dashed rgba(255,255,255,0.1)",
                color: "#8c929c",
              }}
            >
              Belum ada trigger di alur ini.
            </div>
          )}
        </div>
      </div>
    );
  }

  function CreateTriggerBox() {
    return (
      <div
        style={{
          padding: 18,
          borderRadius: 24,
          background: "rgba(0,0,0,0.20)",
          border: "1px solid rgba(0,255,157,0.14)",
        }}
      >
        <h3>Tambah Trigger</h3>
        <p style={{ ...styles.muted, marginTop: 6, marginBottom: 16 }}>
          Trigger akan masuk ke alur: <b style={{ color: "white" }}>{selectedFlow?.name}</b>
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
          <div>
            <label style={styles.label}>Keyword</label>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Contoh: harga, cod, ongkir"
              style={{ ...styles.input, marginBottom: 14 }}
            />

            <label style={styles.label}>Jawaban</label>
            {responseList.map((item, index) => (
              <div key={index} style={{ marginBottom: 10 }}>
                <textarea
                  value={item}
                  onChange={(e) => {
                    const updated = [...responseList];
                    updated[index] = e.target.value;
                    setResponseList(updated);
                    setResponse(joinResponses(updated));
                  }}
                  placeholder={`Jawaban ${index + 1}`}
                  style={styles.textarea}
                />

                {responseList.length > 1 && (
                  <button
                    onClick={() => {
                      const updated = responseList.filter((_, i) => i !== index);
                      setResponseList(updated);
                      setResponse(joinResponses(updated));
                    }}
                    style={{
                      ...styles.button,
                      ...styles.dangerButton,
                      marginTop: 7,
                      padding: "8px 11px",
                    }}
                  >
                    Hapus Jawaban
                  </button>
                )}
              </div>
            ))}

            <button
              onClick={() => setResponseList([...responseList, ""])}
              style={{ ...styles.button, ...styles.ghostButton }}
            >
              + Tambah Jawaban
            </button>
          </div>

          <div>
            <label style={styles.label}>Jenis Trigger</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              style={{ ...styles.input, marginBottom: 14 }}
            >
              <option>Mengandung</option>
              <option>Sama Persis</option>
            </select>

            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: 14,
                borderRadius: 16,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
                marginBottom: 14,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={isFlowEntry}
                onChange={(e) => setIsFlowEntry(e.target.checked)}
              />
              <span>Masuk / pindah alur</span>
            </label>

            <label style={styles.label}>Foto / Video untuk Jawaban</label>

            <select
              value={mediaAnswerIndex}
              onChange={(e) => setMediaAnswerIndex(Number(e.target.value))}
              style={{ ...styles.input, marginBottom: 12 }}
            >
              {responseList.map((_, index) => (
                <option key={index} value={index}>
                  Media untuk Jawaban {index + 1}
                </option>
              ))}
            </select>

            <label
              style={{
                display: "block",
                padding: 16,
                borderRadius: 18,
                border: "1px dashed rgba(0,255,157,0.32)",
                background: "rgba(0,255,157,0.055)",
                textAlign: "center",
                cursor: "pointer",
                marginBottom: 12,
              }}
            >
              <input
                type="file"
                accept="image/*,video/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  files.forEach((file) => uploadMedia(file, mediaAnswerIndex));
                  e.target.value = "";
                }}
              />
              <b>Upload Media</b>
              <p style={{ ...styles.muted, fontSize: 13, marginTop: 5 }}>
                Media akan masuk ke Jawaban {mediaAnswerIndex + 1}
              </p>
            </label>

            {uploading && (
              <p style={{ color: "#00ff9d", marginBottom: 10 }}>
                Upload media... {uploadingCount} file
              </p>
            )}

            {media.length > 0 && MediaGrid({ items: media, onRemove: removeMedia })}
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            padding: 16,
            borderRadius: 20,
            background: "rgba(255,255,255,0.035)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div>
              <h3 style={{ fontSize: 18 }}>Follow Up</h3>
              <p style={{ ...styles.muted, fontSize: 13, marginTop: 5 }}>
                Follow up berhenti otomatis kalau customer membalas.
              </p>
            </div>

            <button
              onClick={() => addFollowup("create")}
              style={{ ...styles.button, ...styles.ghostButton, padding: "8px 11px" }}
            >
              + Follow Up
            </button>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {followups.map((item, index) => (
              <div
                key={index}
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 1fr auto",
                  gap: 10,
                  alignItems: "start",
                  padding: 12,
                  borderRadius: 16,
                  background: "rgba(0,0,0,0.16)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div>
                  <label style={styles.label}>Menit</label>
                  <input
                    type="number"
                    min="1"
                    value={item.delayMinutes}
                    onChange={(e) =>
                      updateFollowupValue(
                        index,
                        "delayMinutes",
                        e.target.value,
                        "create"
                      )
                    }
                    style={styles.input}
                  />
                </div>

                <div>
                  <label style={styles.label}>Follow Up {index + 1}</label>
                  <textarea
                    value={item.message}
                    onChange={(e) =>
                      updateFollowupValue(index, "message", e.target.value, "create")
                    }
                    placeholder="Contoh: mau pesan yang mana kak?"
                    style={{ ...styles.textarea, minHeight: 74 }}
                  />
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      marginTop: 8,
                      color: "#d1d5db",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={item.active !== false}
                      onChange={(e) =>
                        updateFollowupValue(index, "active", e.target.checked, "create")
                      }
                    />
                    Aktif
                  </label>
                </div>

                <button
                  onClick={() => removeFollowup(index, "create")}
                  style={{ ...styles.button, ...styles.dangerButton, padding: "8px 11px" }}
                >
                  Hapus
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button
            onClick={addTrigger}
            disabled={uploading}
            className={!uploading ? "green-btn" : ""}
            style={{
              ...styles.button,
              opacity: uploading ? 0.5 : 1,
              cursor: uploading ? "not-allowed" : "pointer",
            }}
          >
            Simpan Trigger
          </button>

          <button
            onClick={() => setShowCreateForm(false)}
            style={{ ...styles.button, ...styles.ghostButton }}
          >
            Batal
          </button>
        </div>
      </div>
    );
  }

  function MediaGrid({ items, onRemove }) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        {items.map((item, index) => (
          <div
            key={index}
            style={{
              padding: 8,
              borderRadius: 16,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <p
              style={{
                color: "#00ff9d",
                fontSize: 12,
                fontWeight: 850,
                marginBottom: 7,
              }}
            >
              {getMediaLabel(item)}
            </p>

            {item.type === "video" ? (
              <video
                src={item.url}
                controls
                style={{
                  width: "100%",
                  borderRadius: 12,
                  display: "block",
                  marginBottom: 7,
                }}
              />
            ) : (
              <img
                src={item.url}
                alt="Preview"
                style={{
                  width: "100%",
                  borderRadius: 12,
                  display: "block",
                  marginBottom: 7,
                }}
              />
            )}

            {onRemove && (
              <button
                onClick={() => onRemove(index)}
                style={{
                  ...styles.button,
                  ...styles.dangerButton,
                  width: "100%",
                  padding: "8px 10px",
                }}
              >
                Hapus
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  function MediaPreview({ item }) {
    const itemMedia = getMediaFromItem(item);

    if (itemMedia.length === 0) {
      return null;
    }

    const grouped = itemMedia.reduce((acc, mediaItem) => {
      const answerIndex = getMediaAnswerIndex(mediaItem);
      if (!acc[answerIndex]) acc[answerIndex] = [];
      acc[answerIndex].push(mediaItem);
      return acc;
    }, {});

    return (
      <div style={{ marginTop: 14 }}>
        <p style={{ ...styles.muted, fontSize: 13, marginBottom: 8 }}>
          Media: {getMediaSummary(item)}
        </p>

        <div style={{ display: "grid", gap: 12 }}>
          {Object.keys(grouped)
            .sort((a, b) => Number(a) - Number(b))
            .map((answerIndex) => {
              const mediaItems = grouped[answerIndex];

              return (
                <div key={answerIndex}>
                  <p
                    style={{
                      color: "#00ff9d",
                      fontSize: 12,
                      fontWeight: 850,
                      marginBottom: 8,
                    }}
                  >
                    Media Jawaban {Number(answerIndex) + 1}
                  </p>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        mediaItems.length === 1
                          ? "minmax(0, 220px)"
                          : "repeat(2, minmax(0, 160px))",
                      gap: 10,
                    }}
                  >
                    {mediaItems.slice(0, 4).map((mediaItem, mediaIndex) => (
                      <div
                        key={mediaIndex}
                        style={{
                          position: "relative",
                          height: mediaItems.length === 1 ? 145 : 105,
                          borderRadius: 18,
                          overflow: "hidden",
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.08)",
                        }}
                      >
                        {mediaItem.type === "video" ? (
                          <>
                            <video
                              src={mediaItem.url}
                              muted
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                                display: "block",
                              }}
                            />
                            <span
                              style={{
                                position: "absolute",
                                left: 8,
                                bottom: 8,
                                padding: "4px 8px",
                                borderRadius: 999,
                                fontSize: 11,
                                fontWeight: 850,
                                background: "rgba(0,0,0,0.62)",
                              }}
                            >
                              VIDEO
                            </span>
                          </>
                        ) : (
                          <img
                            src={mediaItem.url}
                            alt="Media Preview"
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                              display: "block",
                            }}
                          />
                        )}

                        {mediaIndex === 3 && mediaItems.length > 4 && (
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              display: "grid",
                              placeItems: "center",
                              background: "rgba(0,0,0,0.58)",
                              fontWeight: 950,
                            }}
                          >
                            +{mediaItems.length - 4}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    );
  }

  function TriggerCard({ item }) {
    const answers = getResponseParts(item.response);
    const itemFollowups = getFollowupsFromItem(item).filter(
      (followup) => followup?.active !== false && String(followup?.message || "").trim()
    );

    if (editingTriggerId === item.id) {
      return EditTriggerCard({ item });
    }

    return (
      <div
        style={{
          padding: 18,
          borderRadius: 24,
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.075)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 14,
            alignItems: "flex-start",
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 9 }}>
              <span
                style={{
                  ...styles.pill,
                  background: item.active
                    ? "rgba(0,255,157,0.12)"
                    : "rgba(255,77,103,0.12)",
                  color: item.active ? "#00ff9d" : "#ff7b90",
                }}
              >
                ● {item.active ? "Aktif" : "Nonaktif"}
              </span>

              <span
                style={{
                  ...styles.pill,
                  background: "rgba(255,255,255,0.06)",
                  color: "#d1d5db",
                }}
              >
                {item.is_flow_entry ? "Masuk/Pindah Alur" : item.type}
              </span>

              <span
                style={{
                  ...styles.pill,
                  background: "rgba(255,255,255,0.06)",
                  color: "#d1d5db",
                }}
              >
                {answers.length} Jawaban
              </span>

              <span
                style={{
                  ...styles.pill,
                  background: itemFollowups.length > 0
                    ? "rgba(0,255,157,0.10)"
                    : "rgba(255,255,255,0.06)",
                  color: itemFollowups.length > 0 ? "#00ff9d" : "#d1d5db",
                }}
              >
                {itemFollowups.length} Follow Up
              </span>
            </div>

            <h3 style={{ fontSize: 22, letterSpacing: -0.5 }}>{item.keyword}</h3>
          </div>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {answers.length > 0 ? (
            answers.map((answer, index) => (
              <div
                key={index}
                style={{
                  padding: 14,
                  borderRadius: 18,
                  background: "rgba(0,0,0,0.20)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <p
                  style={{
                    color: "#00ff9d",
                    fontSize: 12,
                    fontWeight: 850,
                    marginBottom: 6,
                  }}
                >
                  Jawaban {index + 1}:
                </p>
                <p style={{ color: "#e5e7eb", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                  {answer}
                </p>
              </div>
            ))
          ) : (
            <p style={styles.muted}>Tidak ada teks jawaban.</p>
          )}
        </div>

        {MediaPreview({ item })}

        {itemFollowups.length > 0 && (
          <div
            style={{
              marginTop: 14,
              display: "grid",
              gap: 8,
            }}
          >
            {itemFollowups.map((followup, index) => (
              <div
                key={index}
                style={{
                  padding: 12,
                  borderRadius: 16,
                  background: "rgba(0,255,157,0.055)",
                  border: "1px solid rgba(0,255,157,0.12)",
                }}
              >
                <p
                  style={{
                    color: "#00ff9d",
                    fontSize: 12,
                    fontWeight: 850,
                    marginBottom: 5,
                  }}
                >
                  Follow Up {index + 1} · {followup.delayMinutes} menit
                </p>
                <p style={{ color: "#e5e7eb", lineHeight: 1.55 }}>
                  {followup.message}
                </p>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 16 }}>
          <button
            onClick={() => startEditTrigger(item)}
            style={{ ...styles.button, ...styles.ghostButton, padding: "9px 12px" }}
          >
            Edit
          </button>

          <button
            onClick={() => duplicateTrigger(item)}
            style={{
              ...styles.button,
              background: "rgba(0,255,157,0.12)",
              color: "#00ff9d",
              border: "1px solid rgba(0,255,157,0.18)",
              padding: "9px 12px",
            }}
          >
            Salin
          </button>

          <button
            onClick={() =>
              setCopyingTriggerId(copyingTriggerId === item.id ? null : item.id)
            }
            style={{ ...styles.button, ...styles.ghostButton, padding: "9px 12px" }}
          >
            Salin ke Alur
          </button>

          <button
            onClick={() => toggleStatus(item.id, item.active)}
            style={{ ...styles.button, ...styles.ghostButton, padding: "9px 12px" }}
          >
            {item.active ? "Nonaktifkan" : "Aktifkan"}
          </button>

          <button
            onClick={() => deleteTrigger(item.id)}
            style={{ ...styles.button, ...styles.dangerButton, padding: "9px 12px" }}
          >
            Hapus
          </button>

          {copyingTriggerId === item.id && (
            <div
              style={{
                width: "100%",
                marginTop: 8,
                padding: 13,
                borderRadius: 18,
                background: "rgba(255,255,255,0.055)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <label style={styles.label}>Salin ke alur</label>
              <select
                value={copyTargetFlow[item.id] || ""}
                onChange={(e) =>
                  setCopyTargetFlow({
                    ...copyTargetFlow,
                    [item.id]: e.target.value,
                  })
                }
                style={{ ...styles.input, marginBottom: 10 }}
              >
                <option value="">Pilih alur tujuan</option>
                {flows.map((flow) => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </select>

              <button
                onClick={() => {
                  const target = copyTargetFlow[item.id];
                  if (!target) return alert("Pilih alur tujuan dulu");
                  duplicateTrigger(item, Number(target));
                }}
                className="green-btn"
                style={{ ...styles.button, width: "100%" }}
              >
                Salin Trigger
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  function EditTriggerCard({ item }) {
    return (
      <div
        style={{
          padding: 18,
          borderRadius: 24,
          background: "rgba(0,255,157,0.06)",
          border: "1px solid rgba(0,255,157,0.16)",
        }}
      >
        <h3 style={{ marginBottom: 14 }}>Edit Trigger</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 16 }}>
          <div>
            <label style={styles.label}>Keyword</label>
            <input
              value={editKeyword}
              onChange={(e) => setEditKeyword(e.target.value)}
              style={{ ...styles.input, marginBottom: 14 }}
            />

            <label style={styles.label}>Jawaban</label>
            {editResponseList.map((answer, index) => (
              <div key={index} style={{ marginBottom: 10 }}>
                <textarea
                  value={answer}
                  onChange={(e) => {
                    const updated = [...editResponseList];
                    updated[index] = e.target.value;
                    setEditResponseList(updated);
                    setEditResponse(joinResponses(updated));
                  }}
                  placeholder={`Jawaban ${index + 1}`}
                  style={styles.textarea}
                />

                {editResponseList.length > 1 && (
                  <button
                    onClick={() => {
                      const updated = editResponseList.filter((_, i) => i !== index);
                      setEditResponseList(updated);
                      setEditResponse(joinResponses(updated));
                    }}
                    style={{
                      ...styles.button,
                      ...styles.dangerButton,
                      marginTop: 7,
                      padding: "8px 11px",
                    }}
                  >
                    Hapus Jawaban
                  </button>
                )}
              </div>
            ))}

            <button
              onClick={() => setEditResponseList([...editResponseList, ""])}
              style={{ ...styles.button, ...styles.ghostButton }}
            >
              + Tambah Jawaban
            </button>
          </div>

          <div>
            <label style={styles.label}>Jenis Trigger</label>
            <select
              value={editType}
              onChange={(e) => setEditType(e.target.value)}
              style={{ ...styles.input, marginBottom: 14 }}
            >
              <option>Mengandung</option>
              <option>Sama Persis</option>
            </select>

            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: 14,
                borderRadius: 16,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
                marginBottom: 14,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={editIsFlowEntry}
                onChange={(e) => setEditIsFlowEntry(e.target.checked)}
              />
              <span>Masuk / pindah alur</span>
            </label>

            <label style={styles.label}>Foto / Video untuk Jawaban</label>

            <select
              value={editMediaAnswerIndex}
              onChange={(e) => setEditMediaAnswerIndex(Number(e.target.value))}
              style={{ ...styles.input, marginBottom: 12 }}
            >
              {editResponseList.map((_, index) => (
                <option key={index} value={index}>
                  Media untuk Jawaban {index + 1}
                </option>
              ))}
            </select>

            <label
              style={{
                display: "block",
                padding: 16,
                borderRadius: 18,
                border: "1px dashed rgba(0,255,157,0.32)",
                background: "rgba(0,255,157,0.055)",
                textAlign: "center",
                cursor: "pointer",
                marginBottom: 12,
              }}
            >
              <input
                type="file"
                accept="image/*,video/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  files.forEach((file) => uploadEditMedia(file, editMediaAnswerIndex));
                  e.target.value = "";
                }}
              />
              <b>Upload Media</b>
              <p style={{ ...styles.muted, fontSize: 13, marginTop: 5 }}>
                Media akan masuk ke Jawaban {editMediaAnswerIndex + 1}
              </p>
            </label>

            {editUploading && (
              <p style={{ color: "#00ff9d", marginBottom: 10 }}>
                Upload... {editUploadingCount} file
              </p>
            )}

            {editMedia.length > 0 && MediaGrid({ items: editMedia, onRemove: removeEditMedia })}
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            padding: 16,
            borderRadius: 20,
            background: "rgba(255,255,255,0.035)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div>
              <h3 style={{ fontSize: 18 }}>Follow Up</h3>
              <p style={{ ...styles.muted, fontSize: 13, marginTop: 5 }}>
                Jika customer membalas, follow up berikutnya berhenti otomatis.
              </p>
            </div>

            <button
              onClick={() => addFollowup("edit")}
              style={{ ...styles.button, ...styles.ghostButton, padding: "8px 11px" }}
            >
              + Follow Up
            </button>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {editFollowups.map((item, index) => (
              <div
                key={index}
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 1fr auto",
                  gap: 10,
                  alignItems: "start",
                  padding: 12,
                  borderRadius: 16,
                  background: "rgba(0,0,0,0.16)",
                  border: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div>
                  <label style={styles.label}>Menit</label>
                  <input
                    type="number"
                    min="1"
                    value={item.delayMinutes}
                    onChange={(e) =>
                      updateFollowupValue(index, "delayMinutes", e.target.value, "edit")
                    }
                    style={styles.input}
                  />
                </div>

                <div>
                  <label style={styles.label}>Follow Up {index + 1}</label>
                  <textarea
                    value={item.message}
                    onChange={(e) =>
                      updateFollowupValue(index, "message", e.target.value, "edit")
                    }
                    placeholder="Contoh: mau pesan yang mana kak?"
                    style={{ ...styles.textarea, minHeight: 74 }}
                  />
                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      marginTop: 8,
                      color: "#d1d5db",
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={item.active !== false}
                      onChange={(e) =>
                        updateFollowupValue(index, "active", e.target.checked, "edit")
                      }
                    />
                    Aktif
                  </label>
                </div>

                <button
                  onClick={() => removeFollowup(index, "edit")}
                  style={{ ...styles.button, ...styles.dangerButton, padding: "8px 11px" }}
                >
                  Hapus
                </button>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button
            onClick={() => saveEditTrigger(item.id)}
            disabled={editUploading}
            className={!editUploading ? "green-btn" : ""}
            style={{
              ...styles.button,
              opacity: editUploading ? 0.5 : 1,
              cursor: editUploading ? "not-allowed" : "pointer",
            }}
          >
            Simpan
          </button>

          <button
            onClick={() => {
              setEditingTriggerId(null);
              setEditMedia([]);
              setEditImage("");
              setEditMediaAnswerIndex(0);
              setEditFollowups([
                {
                  delayMinutes: 5,
                  message: "",
                  active: true,
                },
              ]);
              setEditUploadingCount(0);
            }}
            style={{ ...styles.button, ...styles.ghostButton }}
          >
            Batal
          </button>
        </div>
      </div>
    );
  }


  function TemplatePage() {
    if (templateSelectedFlow) {
      const flowTriggers = allTriggers.filter(
        (item) => item.flow_id === templateSelectedFlow.id
      );

      return (
        <>
          {Header({
            title: templateSelectedFlow.name,
            description: "Detail alur yang berisi semua trigger, jawaban, dan media yang sudah dibuat.",
          })}

          <div className="glass-card" style={styles.section}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 14,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div>
                <button
                  onClick={() => {
                    setTemplateSelectedFlow(null);
                    setShowCreateForm(false);
                    setEditingTriggerId(null);
                  }}
                  style={{
                    ...styles.button,
                    ...styles.ghostButton,
                    marginBottom: 14,
                    padding: "9px 13px",
                  }}
                >
                  ← Kembali ke Daftar Alur
                </button>

                <p style={styles.muted}>Detail Alur</p>
                <h2 style={{ marginTop: 7, fontSize: 30, letterSpacing: -0.8 }}>
                  {templateSelectedFlow.name}
                </h2>
                <p style={{ ...styles.muted, marginTop: 8 }}>
                  {flowTriggers.length} trigger tersimpan di alur ini.
                </p>
              </div>

              <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                <button
                  onClick={() => {
                    setSelectedFlow(templateSelectedFlow);
                    setShowCreateForm(!showCreateForm);
                  }}
                  className="green-btn"
                  style={styles.button}
                >
                  + Tambah Trigger
                </button>

                <button
                  onClick={() => {
                    setEditingFlowId(templateSelectedFlow.id);
                    setEditingFlowName(templateSelectedFlow.name);
                  }}
                  style={{ ...styles.button, ...styles.ghostButton }}
                >
                  Edit Alur
                </button>

                <button
                  onClick={() => startEditCheckout(templateSelectedFlow)}
                  style={{ ...styles.button, ...styles.ghostButton }}
                >
                  Setting Checkout
                </button>

                <button
                  onClick={() => deleteFlow(templateSelectedFlow.id)}
                  style={{ ...styles.button, ...styles.dangerButton }}
                >
                  Hapus Alur
                </button>
              </div>
            </div>

            {editingFlowId === templateSelectedFlow.id && (
              <div
                style={{
                  marginTop: 18,
                  padding: 16,
                  borderRadius: 22,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <label style={styles.label}>Nama Alur</label>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <input
                    value={editingFlowName}
                    onChange={(e) => setEditingFlowName(e.target.value)}
                    style={{ ...styles.input, flex: 1, minWidth: 240 }}
                  />
                  <button
                    onClick={() => updateFlowName(templateSelectedFlow.id)}
                    className="green-btn"
                    style={styles.button}
                  >
                    Simpan
                  </button>
                  <button
                    onClick={() => {
                      setEditingFlowId(null);
                      setEditingFlowName("");
                    }}
                    style={{ ...styles.button, ...styles.ghostButton }}
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}

            {checkoutEditingFlowId === templateSelectedFlow.id && (
              <div
                style={{
                  marginTop: 18,
                  padding: 18,
                  borderRadius: 22,
                  background: "rgba(0,255,157,0.055)",
                  border: "1px solid rgba(0,255,157,0.14)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    alignItems: "center",
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <h3>Setting Checkout</h3>
                    <p style={{ ...styles.muted, fontSize: 13, marginTop: 5, lineHeight: 1.7 }}>
                      Harga dan ongkir ini khusus untuk alur ini saja. Kalimat tetap dibuat di Trigger/Jawaban biasa. Placeholder yang bisa dipakai: [area], [ongkir], [total], [subtotal], [qty], [produk], [harga]. Untuk keyword dinamis ongkir, boleh pakai: ke [area], ongkir [area], atau [area] berapa.
                    </p>
                  </div>

                  <label
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      color: "#d1d5db",
                      fontWeight: 800,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checkoutForm.enabled}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          enabled: e.target.checked,
                        })
                      }
                    />
                    Aktifkan Checkout
                  </label>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 12,
                  }}
                >
                  <div>
                    <label style={styles.label}>Nama Produk</label>
                    <input
                      value={checkoutForm.productName}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          productName: e.target.value,
                        })
                      }
                      placeholder="Contoh: Lampu"
                      style={styles.input}
                    />
                  </div>

                  <div>
                    <label style={styles.label}>Ongkir Default</label>
                    <input
                      type="number"
                      value={checkoutForm.defaultShipping}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          defaultShipping: e.target.value,
                        })
                      }
                      placeholder="Contoh: 20000"
                      style={styles.input}
                    />
                  </div>

                  <div>
                    <label style={styles.label}>Harga 1 pcs</label>
                    <input
                      type="number"
                      value={checkoutForm.price1}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          price1: e.target.value,
                        })
                      }
                      placeholder="Contoh: 10000"
                      style={styles.input}
                    />
                  </div>

                  <div>
                    <label style={styles.label}>Harga 2 pcs</label>
                    <input
                      type="number"
                      value={checkoutForm.price2}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          price2: e.target.value,
                        })
                      }
                      placeholder="Contoh: 18000"
                      style={styles.input}
                    />
                  </div>

                  <div>
                    <label style={styles.label}>Harga Tambahan pcs ke-3 dst</label>
                    <input
                      type="number"
                      value={checkoutForm.priceExtra}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          priceExtra: e.target.value,
                        })
                      }
                      placeholder="Contoh: 9000"
                      style={styles.input}
                    />
                  </div>

                  <div>
                    <label style={styles.label}>Ongkir per Area</label>
                    <textarea
                      value={checkoutForm.shippingByAreaText}
                      onChange={(e) =>
                        setCheckoutForm({
                          ...checkoutForm,
                          shippingByAreaText: e.target.value,
                        })
                      }
                      placeholder={"bandung=15000\njakarta=20000"}
                      style={{ ...styles.textarea, minHeight: 110 }}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                  <button
                    onClick={() => saveCheckout(templateSelectedFlow.id)}
                    className="green-btn"
                    style={styles.button}
                  >
                    Simpan Checkout
                  </button>

                  <button
                    onClick={() => setCheckoutEditingFlowId(null)}
                    style={{ ...styles.button, ...styles.ghostButton }}
                  >
                    Batal
                  </button>
                </div>
              </div>
            )}
          </div>

          {showCreateForm && selectedFlow?.id === templateSelectedFlow.id && (
            <div className="glass-card" style={styles.section}>
              {CreateTriggerBox()}
            </div>
          )}

          <div style={{ display: "grid", gap: 14 }}>
            {flowTriggers.map((trigger) => (
              <div key={trigger.id}>{TriggerCard({ item: trigger })}</div>
            ))}

            {flowTriggers.length === 0 && (
              <div className="glass-card" style={styles.section}>
                <p style={styles.muted}>
                  Belum ada trigger di alur ini. Klik tombol + Tambah Trigger untuk membuat.
                </p>
              </div>
            )}
          </div>
        </>
      );
    }

    return (
      <>
        {Header({
          title: "Template",
          description: "Pilih alur untuk melihat trigger di dalamnya.",
        })}

        <div className="glass-card" style={styles.section}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 12,
              alignItems: "end",
              marginBottom: 18,
            }}
          >
            <div>
              <label style={styles.label}>Tambah Alur</label>
              <input
                value={newFlowName}
                onChange={(e) => setNewFlowName(e.target.value)}
                placeholder="Contoh: Produk Tas, Produk Lampu, Promo"
                style={styles.input}
              />
            </div>

            <button onClick={addFlow} className="green-btn" style={styles.button}>
              + Tambah
            </button>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {flows.map((flow) => {
              const flowTriggers = allTriggers.filter((item) => item.flow_id === flow.id);
              const activeCount = flowTriggers.filter((item) => item.active).length;
              const mediaCount = flowTriggers.filter(
                (item) => getMediaFromItem(item).length > 0
              ).length;

              return (
                <div
                  key={flow.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: 14,
                    borderRadius: 18,
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.075)",
                  }}
                >
                  <button
                    onClick={() => {
                      setTemplateSelectedFlow(flow);
                      setSelectedFlow(flow);
                      setShowCreateForm(false);
                      setEditingTriggerId(null);
                    }}
                    className="sidebar-item"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      textAlign: "left",
                      cursor: "pointer",
                      color: "white",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                    }}
                  >
                    <div
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: 14,
                        display: "grid",
                        placeItems: "center",
                        background: "rgba(0,255,157,0.10)",
                        color: "#00ff9d",
                        fontWeight: 900,
                      }}
                    >
                      ▦
                    </div>

                    <div>
                      <h3 style={{ fontSize: 18, letterSpacing: -0.3 }}>
                        {flow.name}
                      </h3>
                      <p style={{ ...styles.muted, marginTop: 5, fontSize: 13 }}>
                        {flowTriggers.length} trigger · {activeCount} aktif · {mediaCount} media · {getCheckoutFromFlow(flow).enabled ? "checkout aktif" : "checkout mati"}
                      </p>
                    </div>
                  </button>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={() => {
                        setTemplateSelectedFlow(flow);
                        setSelectedFlow(flow);
                        setShowCreateForm(false);
                        setEditingTriggerId(null);
                      }}
                      style={{
                        ...styles.button,
                        ...styles.ghostButton,
                        padding: "8px 11px",
                      }}
                    >
                      Buka
                    </button>

                    <button
                      onClick={() => {
                        setEditingFlowId(flow.id);
                        setEditingFlowName(flow.name);
                      }}
                      style={{
                        ...styles.button,
                        ...styles.ghostButton,
                        padding: "8px 11px",
                      }}
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => deleteFlow(flow.id)}
                      style={{
                        ...styles.button,
                        ...styles.dangerButton,
                        padding: "8px 11px",
                      }}
                    >
                      Hapus
                    </button>
                  </div>

                  {editingFlowId === flow.id && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                        paddingTop: 12,
                        borderTop: "1px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <input
                        value={editingFlowName}
                        onChange={(e) => setEditingFlowName(e.target.value)}
                        style={{ ...styles.input, flex: 1, minWidth: 220 }}
                      />

                      <button
                        onClick={() => updateFlowName(flow.id)}
                        className="green-btn"
                        style={styles.button}
                      >
                        Simpan
                      </button>

                      <button
                        onClick={() => {
                          setEditingFlowId(null);
                          setEditingFlowName("");
                        }}
                        style={{ ...styles.button, ...styles.ghostButton }}
                      >
                        Batal
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {flows.length === 0 && (
              <div
                style={{
                  padding: 18,
                  borderRadius: 18,
                  background: "rgba(255,255,255,0.035)",
                  border: "1px dashed rgba(255,255,255,0.1)",
                }}
              >
                <p style={styles.muted}>Belum ada alur. Tambahkan alur terlebih dahulu.</p>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }


  return (
    <main style={styles.page}>
      <div style={styles.shell}>
        <aside className="glass-card" style={styles.sidebar}>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              paddingBottom: 18,
              borderBottom: "1px solid rgba(255,255,255,0.065)",
              marginBottom: 18,
            }}
          >
            <div style={styles.logo}>N</div>
            <div>
              <h2 style={{ fontSize: 22, letterSpacing: -0.7 }}>NEXIS</h2>
              <p style={{ ...styles.muted, fontSize: 12, marginTop: 4 }}>
                Automation Suite
              </p>
            </div>
          </div>

          {SidebarButton({ id: "perangkat", label: "Perangkat", icon: "●" })}
          {SidebarButton({ id: "template", label: "Template", icon: "▦" })}

          <div
            style={{
              marginTop: 18,
              padding: 14,
              borderRadius: 20,
              background: "rgba(255,255,255,0.035)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <p style={{ ...styles.muted, fontSize: 12, marginBottom: 7 }}>
              Status
            </p>
            <b style={{ color: waStatus ? "#00ff9d" : "#ff7b90" }}>
              {waStatus ? "WhatsApp Terhubung" : "WhatsApp Tidak Terhubung"}
            </b>
          </div>
        </aside>

        <section>
          {activeMenu === "perangkat" ? DevicePage() : TemplatePage()}
        </section>
      </div>

      <style jsx>{`
        @media (max-width: 1100px) {
          main > div {
            grid-template-columns: 1fr !important;
          }

          aside {
            position: relative !important;
            top: auto !important;
            height: auto !important;
          }

          section > div,
          section div[style*="grid-template-columns"] {
            grid-template-columns: 1fr !important;
          }
        }

        @media (max-width: 720px) {
          main {
            padding: 14px !important;
          }
        }
      `}</style>
    </main>
  );
}
