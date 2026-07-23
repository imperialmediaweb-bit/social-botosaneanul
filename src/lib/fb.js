const FB_GRAPH = "https://graph.facebook.com/v21.0";

function validImageUrl(u) {
  return /^https?:\/\/.+\.[a-z]/i.test((u || "").trim());
}

export async function postToPage(pageId, accessToken, message, link) {
  const body = new URLSearchParams();
  body.set("message", message);
  if (link) body.set("link", link);
  body.set("access_token", accessToken);
  const res = await fetch(`${FB_GRAPH}/${pageId}/feed`, { method: "POST", body, cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error(`FB post failed: ${JSON.stringify(data)}`);
  return { id: data.id };
}

export async function postPhotoToPage(pageId, accessToken, imageUrl, message) {
  if (!validImageUrl(imageUrl)) {
    throw new Error(`Poza nu e URL valid: "${(imageUrl || "").slice(0, 60)}"`);
  }
  const body = new URLSearchParams();
  body.set("url", imageUrl);
  body.set("caption", message);
  body.set("access_token", accessToken);
  const res = await fetch(`${FB_GRAPH}/${pageId}/photos`, { method: "POST", body, cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error(`FB photo post failed: ${JSON.stringify(data)}`);
  return { id: data.id, post_id: data.post_id || data.id };
}

async function uploadUnpublishedPhoto(pageId, accessToken, imageUrl) {
  if (!validImageUrl(imageUrl)) {
    throw new Error(`Poza nu e URL valid: "${(imageUrl || "").slice(0, 60)}"`);
  }
  const body = new URLSearchParams();
  body.set("url", imageUrl);
  body.set("published", "false");
  body.set("access_token", accessToken);
  const res = await fetch(`${FB_GRAPH}/${pageId}/photos`, { method: "POST", body, cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error(`FB photo upload failed: ${JSON.stringify(data)}`);
  return data.id;
}

export async function postAlbumToPage(pageId, accessToken, imageUrls, message, maxPhotos = 10) {
  const uploadResults = await Promise.allSettled(
    imageUrls.slice(0, maxPhotos).map((u) => uploadUnpublishedPhoto(pageId, accessToken, u))
  );
  const photo_ids = uploadResults
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
  if (photo_ids.length === 0) throw new Error("FB album: no photos uploaded successfully");
  const body = new URLSearchParams();
  body.set("message", message);
  body.set("access_token", accessToken);
  photo_ids.forEach((id, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const res = await fetch(`${FB_GRAPH}/${pageId}/feed`, { method: "POST", body, cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error(`FB album post failed: ${JSON.stringify(data)}`);
  return { post_id: data.id, photo_ids };
}

export async function commentOnPost(postId, accessToken, message) {
  const body = new URLSearchParams();
  body.set("message", message);
  body.set("access_token", accessToken);
  const res = await fetch(`${FB_GRAPH}/${postId}/comments`, { method: "POST", body, cache: "no-store" });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error(`FB comment failed: ${JSON.stringify(data)}`);
  return { id: data.id };
}
