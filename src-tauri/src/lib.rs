//! The Tauri shell: wires the UI to `clipdeck-core`. Keep logic out of here.

mod commands;
mod hotkey;
mod live;
mod obs;
mod state;
mod toast;
mod tray;

use clipdeck_core::library::Library;
use tauri::Manager;

/// Passed on the command line when Windows starts the app at login.
const STARTED_AT_LOGIN: &str = "--hidden";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must come first. A second copy of ClipDeck does not start: it hands over to the one that is
        // already running, which comes to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(hotkey::plugin())
        // "--hidden" is how the app knows Windows started it at login.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![STARTED_AT_LOGIN]),
        ))
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let library = Library::open(&data_dir.join("clipdeck.db"), &data_dir.join("thumbs"))?;
            let source_dir = library.source_dir()?;
            let _ = commands::library::apply_pending_deletes(&library);

            // The webview may only load local files from folders we allow.
            let scope = app.asset_protocol_scope();
            scope.allow_directory(library.thumbs_dir(), true)?;
            let previews = data_dir.join("previews");
            std::fs::create_dir_all(&previews)?;
            scope.allow_directory(&previews, true)?;
            let icons = data_dir.join("game-icons");
            std::fs::create_dir_all(&icons)?;
            scope.allow_directory(&icons, true)?;
            if let Some(dir) = &source_dir {
                scope.allow_directory(dir, true)?;
            }

            // Notification sounds live in a folder the user can add .wav files to.
            let sounds_dir = data_dir.join("sounds");
            if let Err(problem) = clipdeck_core::sounds::ensure_builtin(&sounds_dir) {
                eprintln!("could not prepare the sounds folder: {problem}");
            }

            app.manage(state::AppState::new(
                library,
                sounds_dir,
                data_dir.join("sound-cache"),
            ));

            // The windows are created here, not automatically, so that no page
            // can call a command before the state above exists.
            // (Skips any window that already exists, in case the app was built
            // with a configuration that still creates them automatically.)
            for window in &app.config().app.windows {
                if app.get_webview_window(&window.label).is_none() {
                    tauri::WebviewWindowBuilder::from_config(app.handle(), window)?.build()?;
                }
            }

            tray::create(app)?;
            toast::prepare(app.handle());

            // The window starts hidden; show it unless Windows launched us at login.
            if !std::env::args().any(|arg| arg == STARTED_AT_LOGIN) {
                tray::show_main_window(app.handle());
                // The opening sound, as the window fades in
                let state = app.state::<state::AppState>();
                if state.library.startup_sound().unwrap_or(true) {
                    let volume = state.library.popup_options().map(|o| o.volume).unwrap_or(70);
                    if volume > 0 {
                        if let Some(path) = clipdeck_core::sounds::startup_sound_path(&state.sound_cache_dir) {
                            clipdeck_core::sounds::play_tracked(
                                &clipdeck_core::sounds::at_volume(&path, volume, &state.sound_cache_dir),
                                clipdeck_core::sounds::startup_sound_length(),
                            );
                        }
                    }
                }
            }

            // A hotkey that is taken by another program must not stop the app starting.
            let wanted_hotkey = app.state::<state::AppState>().library.hotkey()?;
            if let Err(problem) = hotkey::apply(app.handle(), &wanted_hotkey) {
                eprintln!("{problem}");
            }

            obs::autostart(app.handle());
            obs::connect(app.handle());

            if source_dir.is_some() {
                // Catch up on anything that changed while the app was closed,
                // then keep watching for new clips.
                commands::library::spawn_scan(app.handle().clone());
                live::start(app.handle());
            }
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::media::check_tools,
            commands::library::get_settings,
            commands::library::set_source_dir,
            commands::library::set_sort_by_game,
            commands::library::start_scan,
            commands::library::list_clips,
            commands::library::list_folders,
            commands::library::list_dirs,
            commands::library::create_folder,
            commands::library::move_clips,
            commands::library::get_clip,
            commands::app::reveal_in_folder,
            commands::app::import_sound,
            commands::library::set_favorite,
            commands::library::clip_audio_levels,
            commands::library::delete_clips,
            commands::library::mark_pending_delete,
            commands::library::finish_pending_deletes,
            commands::library::set_clip_tags,
            commands::library::list_tags,
            commands::library::list_tag_infos,
            commands::library::set_tag_color,
            commands::library::create_tag,
            commands::library::rename_tag,
            commands::library::delete_tag,
            commands::library::clip_keyframes,
            commands::library::set_clip_notes,
            commands::library::storage_overview,
            commands::library::suggest_games,
            commands::library::assign_games,
            commands::library::copy_clip_file,
            commands::library::list_game_programs,
            commands::library::link_game_program,
            commands::library::copy_clip_files,
            commands::library::cleanup_info,
            commands::library::cleanup_batch,
            commands::library::set_reviewed,
            commands::library::reset_reviewed,
            commands::library::share_clip,
            commands::library::clip_filmstrip,
            commands::library::export_trim,
            commands::library::rename_clip,
            commands::library::set_clip_game,
            commands::library::list_games,
            commands::library::rename_game,
            commands::library::clip_details,
            obs::get_obs_status,
            obs::set_replay_buffer,
            obs::get_obs_settings,
            obs::set_obs_settings,
            obs::launch_obs,
            obs::read_obs_setup,
            obs::apply_obs_setup,
            commands::app::get_app_prefs,
            commands::app::set_hotkey,
            commands::app::pause_hotkey,
            commands::app::set_popups,
            commands::app::set_popup_options,
            commands::app::open_sounds_folder,
            commands::app::test_popup,
            commands::app::set_start_with_windows,
            commands::app::set_startup_sound,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Deletions chosen in a cleanup round are carried out when the app closes.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<state::AppState>() {
                    let _ = commands::library::apply_pending_deletes(&state.library);
                }
            }
        });
}
