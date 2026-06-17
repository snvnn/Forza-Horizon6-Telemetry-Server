#[cfg(target_os = "windows")]
const TIMER_PERIOD_MS: u32 = 1;

pub struct HighResolutionTimer {
    #[cfg(target_os = "windows")]
    enabled: bool,
}

pub fn request_high_resolution_timer() -> HighResolutionTimer {
    request_high_resolution_timer_impl()
}

#[cfg(target_os = "windows")]
fn request_high_resolution_timer_impl() -> HighResolutionTimer {
    let result = unsafe { windows_sys::Win32::Media::timeBeginPeriod(TIMER_PERIOD_MS) };
    let enabled = result == 0;

    if enabled {
        tracing::info!(
            period_ms = TIMER_PERIOD_MS,
            "Windows high resolution timer enabled"
        );
    } else {
        tracing::warn!(
            period_ms = TIMER_PERIOD_MS,
            result,
            "failed to enable Windows high resolution timer"
        );
    }

    HighResolutionTimer { enabled }
}

#[cfg(not(target_os = "windows"))]
fn request_high_resolution_timer_impl() -> HighResolutionTimer {
    HighResolutionTimer {}
}

#[cfg(target_os = "windows")]
impl Drop for HighResolutionTimer {
    fn drop(&mut self) {
        if self.enabled {
            let result = unsafe { windows_sys::Win32::Media::timeEndPeriod(TIMER_PERIOD_MS) };
            if result == 0 {
                tracing::info!(
                    period_ms = TIMER_PERIOD_MS,
                    "Windows high resolution timer released"
                );
            } else {
                tracing::warn!(
                    period_ms = TIMER_PERIOD_MS,
                    result,
                    "failed to release Windows high resolution timer"
                );
            }
        }
    }
}
