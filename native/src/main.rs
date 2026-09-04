use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD}, Engine};
use lofty::{
    config::WriteOptions,
    file::{AudioFile, TaggedFileExt},
    picture::{MimeType, Picture, PictureType},
    prelude::{Accessor, ItemKey},
    probe::Probe,
    tag::{ItemValue, Tag, TagItem, TagType},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{env, fs, io::{self, Read}, path::{Path, PathBuf}};
use rusty_chromaprint::{Configuration, FingerprintCompressor, Fingerprinter};
use symphonia::core::{audio::sample::Sample, codecs::audio::AudioDecoderOptions, errors::Error as SymphoniaError, formats::{FormatOptions, TrackType, probe::Hint}, io::MediaSourceStream, meta::MetadataOptions};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteRequest { path: PathBuf, patch: TagPatch }

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagPatch {
    title: Option<Option<String>>,
    artists: Option<Vec<String>>,
    album_artists: Option<Vec<String>>,
    album: Option<Option<String>>,
    track_number: Option<Option<u32>>,
    track_total: Option<Option<u32>>,
    disc_number: Option<Option<u32>>,
    disc_total: Option<Option<u32>>,
    date: Option<Option<String>>,
    genres: Option<Vec<String>>,
    composers: Option<Vec<String>>,
    comment: Option<Option<String>>,
    embedded_lyrics: Option<Option<String>>,
    identifiers: Option<std::collections::HashMap<String, String>>,
    removed_identifiers: Option<Vec<String>>,
    advanced_tags: Option<Vec<AdvancedTag>>,
    removed_advanced_tags: Option<Vec<String>>,
    cover: Option<Option<Cover>>,
}

#[derive(Deserialize)]
struct AdvancedTag { key: String, value: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cover { mime_type: String, data_base64: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivilegedManifest { version: u8, operations: Vec<PrivilegedOperation>, allowed_roots: Vec<PathBuf> }

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum PrivilegedOperation {
    Replace { source: PathBuf, destination: PathBuf, expected_source_hash: String, expected_destination_hash: Option<String>, mode: Option<u32>, owner_uid: Option<u32>, owner_gid: Option<u32> },
    Move { source: PathBuf, destination: PathBuf, expected_source_hash: String, mode: Option<u32>, owner_uid: Option<u32>, owner_gid: Option<u32> },
    Mkdir { destination: PathBuf },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    match env::args().nth(1).as_deref() {
        Some("write") => write_tags(),
        Some("privileged") => {
            let manifest = env::args().nth(2).context("missing manifest path")?;
            apply_privileged(Path::new(&manifest))
        }
        Some("fingerprint") => {
            let path = env::args().nth(2).context("missing audio path")?;
            fingerprint(Path::new(&path))
        }
        _ => bail!("expected a supported command"),
    }
}

fn fingerprint(path: &Path) -> Result<()> {
    let source = fs::File::open(path).context("unable to open audio for fingerprinting")?;
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) { hint.with_extension(extension); }
    let mut format = symphonia::default::get_probe().probe(&hint, stream, FormatOptions::default(), MetadataOptions::default())?;
    let track = format.default_track(TrackType::Audio).context("audio contains no default track")?;
    let track_id = track.id;
    let parameters = track.codec_params.as_ref().and_then(|value| value.audio()).context("audio codec parameters are unknown")?;
    let sample_rate = parameters.sample_rate.context("audio sample rate is unknown")?;
    let channels = parameters.channels.as_ref().context("audio channel count is unknown")?.count();
    let mut decoder = symphonia::default::get_codecs().make_audio_decoder(parameters, &AudioDecoderOptions::default())?;
    let config = Configuration::preset_test2();
    let mut printer = Fingerprinter::new(&config);
    printer.start(sample_rate, channels as u32).map_err(|error| anyhow::anyhow!("fingerprint initialization failed: {error:?}"))?;
    let mut frames: u64 = 0;
    loop {
        let packet = match format.next_packet() { Ok(Some(packet)) => packet, Ok(None) => break, Err(SymphoniaError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => break, Err(error) => return Err(error.into()) };
        if packet.track_id != track_id { continue; }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let mut samples = vec![i16::MID; decoded.samples_interleaved()];
                decoded.copy_to_slice_interleaved(&mut samples);
                frames += (samples.len() / channels) as u64;
                printer.consume(&samples);
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(error.into()),
        }
    }
    printer.finish();
    let compressed = FingerprintCompressor::from(&config).compress(printer.fingerprint());
    let result = serde_json::json!({ "fingerprint": URL_SAFE_NO_PAD.encode(compressed), "duration": (frames / sample_rate as u64).max(1) });
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

fn write_tags() -> Result<()> {
    let mut input = String::new();
    io::stdin().take(10 * 1024 * 1024).read_to_string(&mut input)?;
    let request: WriteRequest = serde_json::from_str(&input).context("invalid write request")?;
    let mut tagged = Probe::open(&request.path)?.read().context("unable to parse audio file")?;
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() { tagged.insert_tag(Tag::new(tag_type)); }
    let tag = tagged.primary_tag_mut().context("audio format has no writable primary tag")?;
    apply_patch(tag, request.patch)?;
    tagged.save_to_path(&request.path, WriteOptions::default()).context("unable to save tags")?;
    Probe::open(&request.path)?.read().context("tagged file failed validation")?;
    Ok(())
}

fn apply_patch(tag: &mut Tag, patch: TagPatch) -> Result<()> {
    if let Some(value) = patch.title { match value { Some(v) if !v.is_empty() => tag.set_title(v), _ => tag.remove_key(ItemKey::TrackTitle) } }
    if let Some(values) = patch.artists { set_joined(tag, ItemKey::TrackArtist, values); }
    if let Some(values) = patch.album_artists { set_joined(tag, ItemKey::AlbumArtist, values); }
    if let Some(value) = patch.album { match value { Some(v) if !v.is_empty() => tag.set_album(v), _ => tag.remove_key(ItemKey::AlbumTitle) } }
    if let Some(value) = patch.track_number { match value { Some(v) => tag.set_track(v), None => tag.remove_key(ItemKey::TrackNumber) } }
    if let Some(value) = patch.track_total { match value { Some(v) => tag.set_track_total(v), None => tag.remove_key(ItemKey::TrackTotal) } }
    if let Some(value) = patch.disc_number { match value { Some(v) => tag.set_disk(v), None => tag.remove_key(ItemKey::DiscNumber) } }
    if let Some(value) = patch.disc_total { match value { Some(v) => tag.set_disk_total(v), None => tag.remove_key(ItemKey::DiscTotal) } }
    if let Some(value) = patch.date { set_text_optional(tag, ItemKey::RecordingDate, value); }
    if let Some(values) = patch.genres { set_joined(tag, ItemKey::Genre, values); }
    if let Some(values) = patch.composers { set_joined(tag, ItemKey::Composer, values); }
    if let Some(value) = patch.comment { match value { Some(v) if !v.is_empty() => tag.set_comment(v), _ => tag.remove_key(ItemKey::Comment) } }
    if let Some(value) = patch.embedded_lyrics {
        let key = if tag.tag_type() == TagType::Id3v2 { ItemKey::UnsyncLyrics } else { ItemKey::Lyrics };
        set_text_optional(tag, key, value);
    }
    if let Some(values) = patch.identifiers {
        for (key, value) in values {
            let item_key = match key.as_str() {
                "musicbrainzRecordingId" => Some(ItemKey::MusicBrainzRecordingId),
                "musicbrainzReleaseId" => Some(ItemKey::MusicBrainzReleaseId),
                "isrc" => Some(ItemKey::Isrc),
                _ => ItemKey::from_key(tag.tag_type(), &key),
            };
            if let Some(item_key) = item_key { set_text_optional(tag, item_key, if value.is_empty() { None } else { Some(value) }); }
        }
    }
    if let Some(keys) = patch.removed_identifiers {
        for key in keys {
            let item_key = match key.as_str() {
                "musicbrainzRecordingId" => Some(ItemKey::MusicBrainzRecordingId),
                "musicbrainzReleaseId" => Some(ItemKey::MusicBrainzReleaseId),
                "isrc" => Some(ItemKey::Isrc),
                _ => ItemKey::from_key(tag.tag_type(), &key),
            };
            if let Some(item_key) = item_key { tag.remove_key(item_key); }
        }
    }
    if let Some(values) = patch.advanced_tags {
        for item in values {
            let key = item.key.split_once(':').map(|(_, key)| key).unwrap_or(&item.key).to_string();
            if let Some(item_key) = ItemKey::from_key(tag.tag_type(), &key) { set_text(tag, item_key, item.value); }
        }
    }
    if let Some(keys) = patch.removed_advanced_tags {
        for item in keys {
            let key = item.split_once(':').map(|(_, key)| key).unwrap_or(&item);
            if let Some(item_key) = ItemKey::from_key(tag.tag_type(), key) { tag.remove_key(item_key); }
        }
    }
    if let Some(cover) = patch.cover {
        tag.remove_picture_type(PictureType::CoverFront);
        if let Some(cover) = cover {
            let mime = match cover.mime_type.as_str() { "image/png" => MimeType::Png, _ => MimeType::Jpeg };
            let bytes = BASE64.decode(cover.data_base64).context("invalid cover image")?;
            tag.push_picture(Picture::unchecked(bytes).pic_type(PictureType::CoverFront).mime_type(mime).build());
        }
    }
    Ok(())
}

fn set_text_optional(tag: &mut Tag, key: ItemKey, value: Option<String>) { match value { Some(value) if !value.is_empty() => set_text(tag, key, value), _ => { tag.remove_key(key); } } }
fn set_joined(tag: &mut Tag, key: ItemKey, values: Vec<String>) { set_text_optional(tag, key, if values.is_empty() { None } else { Some(values.join("; ")) }); }
fn set_text(tag: &mut Tag, key: ItemKey, value: String) { tag.remove_key(key); tag.insert_unchecked(TagItem::new(key, ItemValue::Text(value))); }

fn apply_privileged(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 { bail!("invalid manifest file"); }
    let manifest: PrivilegedManifest = serde_json::from_slice(&fs::read(path)?).context("invalid privileged manifest")?;
    if manifest.version != 1 || manifest.operations.is_empty() || manifest.operations.len() > 500 { bail!("unsupported privileged manifest"); }
    let roots: Vec<PathBuf> = manifest.allowed_roots.iter().map(|root| root.canonicalize()).collect::<Result<_, _>>().context("invalid library root")?;
    for operation in manifest.operations {
        match operation {
            PrivilegedOperation::Replace { source, destination, expected_source_hash, expected_destination_hash, mode, owner_uid, owner_gid } => {
                validate_source(&source, &expected_source_hash)?; validate_destination(&destination, &roots)?;
                match expected_destination_hash {
                    Some(expected) => validate_source(&destination, &expected).context("replacement destination changed")?,
                    None if destination.exists() => bail!("replacement destination appeared"),
                    None => {},
                }
                fs::create_dir_all(destination.parent().context("invalid destination")?)?;
                move_verified(&source, &destination, &expected_source_hash, true)?;
                preserve_unix_metadata(&destination, mode, owner_uid, owner_gid)?;
            }
            PrivilegedOperation::Move { source, destination, expected_source_hash, mode, owner_uid, owner_gid } => {
                validate_source(&source, &expected_source_hash)?; validate_destination(&destination, &roots)?;
                if destination.exists() {
                    validate_source(&destination, &expected_source_hash).context("destination collision")?;
                    fs::remove_file(&source).context("unable to finish verified source cleanup")?;
                    preserve_unix_metadata(&destination, mode, owner_uid, owner_gid)?;
                    continue;
                }
                fs::create_dir_all(destination.parent().context("invalid destination")?)?;
                move_verified(&source, &destination, &expected_source_hash, false)?;
                preserve_unix_metadata(&destination, mode, owner_uid, owner_gid)?;
            }
            PrivilegedOperation::Mkdir { destination } => { validate_destination(&destination, &roots)?; fs::create_dir_all(destination)?; }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn preserve_unix_metadata(path: &Path, mode: Option<u32>, uid: Option<u32>, gid: Option<u32>) -> Result<()> {
    use std::os::unix::fs::{PermissionsExt, chown};
    if let Some(mode) = mode { fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))?; }
    if uid.is_some() || gid.is_some() { chown(path, uid, gid)?; }
    Ok(())
}
#[cfg(not(unix))]
fn preserve_unix_metadata(_path: &Path, _mode: Option<u32>, _uid: Option<u32>, _gid: Option<u32>) -> Result<()> { Ok(()) }

fn move_verified(source: &Path, destination: &Path, expected_hash: &str, replace: bool) -> Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {},
        Err(error) => return Err(error).context("privileged rename failed"),
    }
    let temporary = destination.with_extension(format!("{}.library-tagger.tmp", destination.extension().and_then(|value| value.to_str()).unwrap_or("file")));
    let result = (|| -> Result<()> {
        let mut input = fs::File::open(source).context("privileged source reopen failed")?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).context("privileged temporary destination already exists")?;
        io::copy(&mut input, &mut output).context("privileged cross-filesystem copy failed")?;
        output.sync_all()?;
        if sha256(&temporary)? != expected_hash { bail!("privileged copy hash mismatch"); }
        if !replace && destination.exists() { bail!("destination appeared during copy"); }
        fs::rename(&temporary, destination).context("privileged copy finalize failed")?;
        fs::remove_file(source).context("privileged source cleanup failed")?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

fn validate_source(path: &Path, expected_hash: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() { bail!("source is not a regular file"); }
    if sha256(path)? != expected_hash { bail!("source hash mismatch"); }
    Ok(())
}
fn validate_destination(path: &Path, roots: &[PathBuf]) -> Result<()> {
    if path.file_name().is_none() { bail!("invalid destination"); }
    let parent = path.parent().context("invalid destination parent")?;
    let mut existing = parent;
    while !existing.exists() { existing = existing.parent().context("destination has no existing ancestor")?; }
    let canonical_parent = existing.canonicalize()?;
    if !roots.iter().any(|root| canonical_parent.starts_with(root)) { bail!("destination is outside registered library roots"); }
    if path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) { bail!("destination is a symbolic link"); }
    Ok(())
}
fn sha256(path: &Path) -> Result<String> { let mut file = fs::File::open(path)?; let mut hash = Sha256::new(); io::copy(&mut file, &mut hash)?; Ok(format!("{:x}", hash.finalize())) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_must_stay_in_registered_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        fs::create_dir(&root).unwrap();
        let roots = vec![root.canonicalize().unwrap()];
        assert!(validate_destination(&root.join("Artist/track.mp3"), &roots).is_ok());
        assert!(validate_destination(&directory.path().join("outside.mp3"), &roots).is_err());
    }

    #[test]
    fn source_hash_is_mandatory() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        fs::write(&source, b"audio").unwrap();
        assert!(validate_source(&source, &sha256(&source).unwrap()).is_ok());
        assert!(validate_source(&source, "wrong").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_source_is_rejected() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target");
        let source = directory.path().join("link");
        fs::write(&target, b"audio").unwrap(); symlink(&target, &source).unwrap();
        assert!(validate_source(&source, &sha256(&target).unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_destination_is_rejected() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("library");
        fs::create_dir(&root).unwrap();
        let target = root.join("target");
        let destination = root.join("link");
        fs::write(&target, b"audio").unwrap(); symlink(&target, &destination).unwrap();
        assert!(validate_destination(&destination, &[root.canonicalize().unwrap()]).is_err());
    }

    #[test]
    fn arbitrary_manifest_actions_are_rejected() {
        let input = r#"{"version":1,"operations":[{"action":"shell","destination":"/tmp"}],"allowedRoots":["/tmp"]}"#;
        assert!(serde_json::from_str::<PrivilegedManifest>(input).is_err());
    }
}
