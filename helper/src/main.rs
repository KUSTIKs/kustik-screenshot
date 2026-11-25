//! kustik-screenshot-helper — screen capture backend for Kustik Screenshot.
//!
//! Uses wlr-screencopy (supported by niri, sway, Hyprland, river…), so there
//! are no portal permission dialogs and a capture is instant.
//!
//!   kustik-screenshot-helper outputs
//!       JSON list of outputs: name, logical x/y/w/h.
//!   kustik-screenshot-helper screenshot --output NAME [--cursor] FILE.png
//!       Full output at physical resolution. Prints {"width","height"}.
//!   kustik-screenshot-helper record --output NAME --region X,Y,W,H [--cursor] [--fps N]
//!       Region in logical px. Prints one JSON header line to stderr
//!       ({"width","height","format":"bgr0"}), then streams raw frames to
//!       stdout until stdout closes or the process is terminated.

use anyhow::{anyhow, bail, Context, Result};
use std::io::Write;
use std::os::fd::AsFd;
use std::time::{Duration, Instant};
use wayland_client::{
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_buffer, wl_output, wl_registry, wl_shm, wl_shm_pool},
    Connection, Dispatch, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};
use wayland_protocols_wlr::screencopy::v1::client::{
    zwlr_screencopy_frame_v1::{self, Flags},
    zwlr_screencopy_manager_v1,
};

#[derive(Default, Clone, Debug)]
struct Output {
    wl: Option<wl_output::WlOutput>,
    name: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(Default, Debug)]
struct FrameInfo {
    format: Option<wl_shm::Format>,
    width: u32,
    height: u32,
    stride: u32,
    y_invert: bool,
    ready: bool,
    failed: bool,
    buffer_done: bool,
}

#[derive(Default)]
struct State {
    outputs: Vec<Output>,
    frame: FrameInfo,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

impl Dispatch<wl_output::WlOutput, usize> for State {
    fn event(state: &mut Self, _: &wl_output::WlOutput, event: wl_output::Event, idx: &usize, _: &Connection, _: &QueueHandle<Self>) {
        if let wl_output::Event::Name { name } = event {
            state.outputs[*idx].name = name;
        }
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, usize> for State {
    fn event(state: &mut Self, _: &zxdg_output_v1::ZxdgOutputV1, event: zxdg_output_v1::Event, idx: &usize, _: &Connection, _: &QueueHandle<Self>) {
        let o = &mut state.outputs[*idx];
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => { o.x = x; o.y = y; }
            zxdg_output_v1::Event::LogicalSize { width, height } => { o.w = width; o.h = height; }
            zxdg_output_v1::Event::Name { name } => { if o.name.is_empty() { o.name = name; } }
            _ => {}
        }
    }
}

impl Dispatch<zwlr_screencopy_frame_v1::ZwlrScreencopyFrameV1, ()> for State {
    fn event(state: &mut Self, _: &zwlr_screencopy_frame_v1::ZwlrScreencopyFrameV1, event: zwlr_screencopy_frame_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        let f = &mut state.frame;
        match event {
            zwlr_screencopy_frame_v1::Event::Buffer { format, width, height, stride } => {
                // Prefer a 32-bit format we know how to convert.
                if let WEnum::Value(fmt) = format {
                    if matches!(fmt, wl_shm::Format::Xrgb8888 | wl_shm::Format::Argb8888 | wl_shm::Format::Xbgr8888 | wl_shm::Format::Abgr8888) && f.format.is_none() {
                        f.format = Some(fmt);
                        f.width = width;
                        f.height = height;
                        f.stride = stride;
                    }
                }
            }
            zwlr_screencopy_frame_v1::Event::Flags { flags } => {
                if let WEnum::Value(fl) = flags { f.y_invert = fl.contains(Flags::YInvert); }
            }
            zwlr_screencopy_frame_v1::Event::BufferDone => f.buffer_done = true,
            zwlr_screencopy_frame_v1::Event::Ready { .. } => f.ready = true,
            zwlr_screencopy_frame_v1::Event::Failed => f.failed = true,
            _ => {}
        }
    }
}

impl Dispatch<wl_shm::WlShm, ()> for State {
    fn event(_: &mut Self, _: &wl_shm::WlShm, _: wl_shm::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<wl_shm_pool::WlShmPool, ()> for State {
    fn event(_: &mut Self, _: &wl_shm_pool::WlShmPool, _: wl_shm_pool::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<wl_buffer::WlBuffer, ()> for State {
    fn event(_: &mut Self, _: &wl_buffer::WlBuffer, _: wl_buffer::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1, ()> for State {
    fn event(_: &mut Self, _: &zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1, _: zwlr_screencopy_manager_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}
impl Dispatch<zxdg_output_manager_v1::ZxdgOutputManagerV1, ()> for State {
    fn event(_: &mut Self, _: &zxdg_output_manager_v1::ZxdgOutputManagerV1, _: zxdg_output_manager_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {}
}

struct Ctx {
    conn: Connection,
    queue: wayland_client::EventQueue<State>,
    qh: QueueHandle<State>,
    state: State,
    shm: wl_shm::WlShm,
    copy: zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1,
}

fn connect() -> Result<Ctx> {
    let conn = Connection::connect_to_env().context("no Wayland connection")?;
    let (globals, mut queue) = registry_queue_init::<State>(&conn)?;
    let qh = queue.handle();
    let mut state = State::default();

    let shm: wl_shm::WlShm = globals.bind(&qh, 1..=1, ())?;
    let copy: zwlr_screencopy_manager_v1::ZwlrScreencopyManagerV1 = globals
        .bind(&qh, 1..=3, ())
        .context("compositor does not support wlr-screencopy")?;
    let xdg: zxdg_output_manager_v1::ZxdgOutputManagerV1 = globals.bind(&qh, 1..=3, ())?;

    let outs: Vec<_> = globals.contents().clone_list().into_iter().filter(|g| g.interface == "wl_output").collect();
    for (i, g) in outs.iter().enumerate() {
        state.outputs.push(Output::default());
        let wl: wl_output::WlOutput = globals.registry().bind(g.name, g.version.min(4), &qh, i);
        xdg.get_xdg_output(&wl, &qh, i);
        state.outputs[i].wl = Some(wl);
    }
    queue.roundtrip(&mut state)?;
    queue.roundtrip(&mut state)?;
    Ok(Ctx { conn, queue, qh, state, shm, copy })
}

/// One captured frame, converted to tightly packed BGRx (ffmpeg "bgr0").
struct Frame {
    width: u32,
    height: u32,
    bgrx: Vec<u8>,
}

impl Ctx {
    fn output(&self, name: &str) -> Result<Output> {
        self.state.outputs.iter().find(|o| o.name == name).cloned()
            .or_else(|| if name.is_empty() { self.state.outputs.first().cloned() } else { None })
            .ok_or_else(|| anyhow!("no output named {name:?}"))
    }

    /// Capture the whole output or a logical region of it.
    fn grab(&mut self, out: &Output, region: Option<(i32, i32, i32, i32)>, cursor: bool) -> Result<Frame> {
        self.state.frame = FrameInfo::default();
        let wl = out.wl.as_ref().unwrap();
        let frame = match region {
            Some((x, y, w, h)) => self.copy.capture_output_region(cursor as i32, wl, x, y, w, h, &self.qh, ()),
            None => self.copy.capture_output(cursor as i32, wl, &self.qh, ()),
        };
        // Wait for the buffer description (buffer_done on v3; one roundtrip on v1/v2).
        while !self.state.frame.buffer_done && !self.state.frame.failed {
            self.queue.blocking_dispatch(&mut self.state)?;
            if self.copy.version() < 3 && self.state.frame.format.is_some() { break; }
        }
        if self.state.frame.failed { bail!("screencopy failed"); }
        let f = &self.state.frame;
        let fmt = f.format.ok_or_else(|| anyhow!("no supported shm format offered"))?;
        let (w, h, stride) = (f.width, f.height, f.stride);
        let size = (stride * h) as usize;

        let fd = rustix::fs::memfd_create("capture", rustix::fs::MemfdFlags::CLOEXEC)?;
        rustix::fs::ftruncate(&fd, size as u64)?;
        let pool = self.shm.create_pool(fd.as_fd(), size as i32, &self.qh, ());
        let buffer = pool.create_buffer(0, w as i32, h as i32, stride as i32, fmt, &self.qh, ());
        frame.copy(&buffer);
        while !self.state.frame.ready && !self.state.frame.failed {
            self.queue.blocking_dispatch(&mut self.state)?;
        }
        if self.state.frame.failed { bail!("screencopy copy failed"); }
        // KUSTIK_FLIP_Y=1: niri's nested (winit) backend delivers frames upside
        // down without setting the y_invert flag. Test-only override.
        let y_invert = self.state.frame.y_invert != std::env::var_os("KUSTIK_FLIP_Y").is_some();
        if std::env::var_os("KUSTIK_DEBUG").is_some() { eprintln!("frame flags: y_invert={}", self.state.frame.y_invert); }

        let map = unsafe { memmap2::Mmap::map(&std::fs::File::from(fd))? };
        let swap_rb = matches!(fmt, wl_shm::Format::Xbgr8888 | wl_shm::Format::Abgr8888);
        let mut bgrx = vec![0u8; (w * h * 4) as usize];
        for row in 0..h {
            let src_row = if y_invert { h - 1 - row } else { row };
            let src = &map[(src_row * stride) as usize..(src_row * stride + w * 4) as usize];
            let dst = &mut bgrx[(row * w * 4) as usize..((row + 1) * w * 4) as usize];
            if swap_rb {
                for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255;
                }
            } else {
                dst.copy_from_slice(src);
            }
        }
        buffer.destroy();
        pool.destroy();
        frame.destroy();
        let _ = self.conn.flush();
        Ok(Frame { width: w, height: h, bgrx })
    }
}

fn write_png(frame: &Frame, path: &str) -> Result<()> {
    let mut rgba = frame.bgrx.clone();
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    let file = std::io::BufWriter::new(std::fs::File::create(path).with_context(|| format!("create {path}"))?);
    let mut enc = png::Encoder::new(file, frame.width, frame.height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    enc.write_header()?.write_image_data(&rgba)?;
    Ok(())
}

fn arg(args: &[String], key: &str) -> Option<String> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1).cloned())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let mut ctx = connect()?;
    let cursor = args.iter().any(|a| a == "--cursor");
    let output = ctx.output(&arg(&args, "--output").unwrap_or_default())?;

    match cmd {
        "outputs" => {
            let list: Vec<String> = ctx.state.outputs.iter().map(|o| {
                format!(r#"{{"name":"{}","x":{},"y":{},"width":{},"height":{}}}"#, o.name, o.x, o.y, o.w, o.h)
            }).collect();
            println!("[{}]", list.join(","));
        }
        "screenshot" => {
            let path = args.last().filter(|p| p.ends_with(".png")).ok_or_else(|| anyhow!("usage: screenshot --output NAME FILE.png"))?.clone();
            let frame = ctx.grab(&output, None, cursor)?;
            write_png(&frame, &path)?;
            println!(r#"{{"width":{},"height":{}}}"#, frame.width, frame.height);
        }
        "record" => {
            let r: Vec<i32> = arg(&args, "--region").ok_or_else(|| anyhow!("--region X,Y,W,H required"))?
                .split(',').map(|v| v.trim().parse::<f64>().map(|f| f.round() as i32)).collect::<Result<_, _>>()?;
            if r.len() != 4 { bail!("--region needs X,Y,W,H"); }
            let fps: f64 = arg(&args, "--fps").and_then(|v| v.parse().ok()).unwrap_or(30.0);
            let interval = Duration::from_secs_f64(1.0 / fps);
            let region = (r[0], r[1], r[2], r[3]);
            let first = ctx.grab(&output, Some(region), cursor)?;
            // Encoders want even dimensions: crop a pixel if needed.
            let (ow, oh) = (first.width & !1, first.height & !1);
            eprintln!(r#"{{"width":{ow},"height":{oh},"format":"bgr0","fps":{fps}}}"#);

            // Capture on its own thread; write at a fixed rate from here. The
            // compositor may only hand out a frame when the screen changes, so a
            // still screen must not stall the video: the latest frame repeats.
            let latest = std::sync::Arc::new(std::sync::Mutex::new(first));
            let shared = latest.clone();
            // Grab no faster than the output rate: extra frames would only be
            // thrown away, and each one is a full-resolution copy.
            std::thread::spawn(move || loop {
                let t = Instant::now();
                match ctx.grab(&output, Some(region), cursor) {
                    Ok(f) => *shared.lock().unwrap() = f,
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
                if let Some(rest) = interval.checked_sub(t.elapsed()) { std::thread::sleep(rest); }
            });

            // SIGTERM/SIGINT ask for a clean stop: finish the frame being written,
            // then exit, so the encoder never receives a cut-off frame.
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            for sig in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
                signal_hook::flag::register(sig, stop.clone())?;
            }

            let mut out = std::io::BufWriter::with_capacity(1 << 20, std::io::stdout().lock());
            let mut next = Instant::now();
            loop {
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let _ = out.flush();
                    std::process::exit(0); // don't wait for the capture thread
                }
                {
                    let frame = latest.lock().unwrap();
                    for row in 0..oh.min(frame.height) {
                        let s = (row * frame.width * 4) as usize;
                        if out.write_all(&frame.bgrx[s..s + (ow * 4) as usize]).is_err() { return Ok(()); }
                    }
                }
                if out.flush().is_err() { return Ok(()); }
                next += interval;
                let now = Instant::now();
                if next > now { std::thread::sleep(next - now); } else { next = now; }
            }
        }
        _ => bail!("usage: kustik-screenshot-helper outputs | screenshot --output NAME FILE.png | record --output NAME --region X,Y,W,H [--fps N]"),
    }
    Ok(())
}
