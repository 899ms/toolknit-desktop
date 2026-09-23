#[cfg(target_os = "windows")]
pub(crate) fn transform(input: &mut [u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| "protected-data:size")?,
        pbData: input.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let result = if protect {
            CryptProtectData(
                &source,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        result.map_err(|_| "protected-data:failed")?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("protected-data:empty".into());
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        if !protect {
            use zeroize::Zeroize;
            std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
        }
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(bytes)
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn transform(_input: &mut [u8], _protect: bool) -> Result<Vec<u8>, String> {
    Err("clipboard:desktop-only".into())
}
