package casa.bilancio.app;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;

import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

/**
 * The page in assets/www is the whole app; this activity only hosts it and lends it {@link Archivio}
 * for the files. Served from the asset loader's https origin, so the BTC price fetch is an ordinary CORS call.
 */
public class MainActivity extends AppCompatActivity {

    private static final int SCEGLI_FILE = 42;

    // Long enough to pick a file or answer a call without unlocking again, short enough for a phone left on a table.
    private static final long BLOCCO_DOPO_MS = 60_000;
    private static final int BLOCCO_FORTE = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    private static final int BLOCCO_DEBOLE = BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private WebView web;
    private View blocco;
    private ValueCallback<Uri[]> sceltaFile;
    private boolean bloccato = true;
    private long usciti = 0;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(0xFF09090B);
        // Android 15 draws every app edge to edge and the WebView reports no safe area, so the bars and the
        // keyboard are kept off the page by padding a frame around it: the WebView ignores its own padding.
        FrameLayout cornice = new FrameLayout(this);
        cornice.setBackgroundColor(0xFF09090B);
        cornice.addView(web);
        // The ledger stays hidden until the phone owner proves who they are: fingerprint, face, or the phone's own PIN.
        Button sblocca = new Button(this);
        sblocca.setText("🔒  Sblocca Bilancio");
        sblocca.setOnClickListener(v -> chiediSblocco());
        FrameLayout velo = new FrameLayout(this);
        velo.setBackgroundColor(0xFF09090B);
        velo.setClickable(true);
        velo.addView(sblocca, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        blocco = velo;
        cornice.addView(blocco);
        setContentView(cornice);
        // Keeps balances out of the recent-apps thumbnail without forbidding screenshots.
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
        ViewCompat.setOnApplyWindowInsetsListener(cornice, (v, insets) -> {
            Insets b = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        // The import sheet's <input type="file"> needs someone to open the system picker for it.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (sceltaFile != null) sceltaFile.onReceiveValue(null);
                sceltaFile = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                startActivityForResult(i, SCEGLI_FILE);
                return true;
            }
        });

        web.addJavascriptInterface(new Archivio(this), "Archivio");
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    private int autenticatori() {
        BiometricManager bm = BiometricManager.from(this);
        if (bm.canAuthenticate(BLOCCO_FORTE) == BiometricManager.BIOMETRIC_SUCCESS) return BLOCCO_FORTE;
        if (bm.canAuthenticate(BLOCCO_DEBOLE) == BiometricManager.BIOMETRIC_SUCCESS) return BLOCCO_DEBOLE;
        return 0;
    }

    private void sblocca() {
        bloccato = false;
        blocco.setVisibility(View.GONE);
    }

    private void chiediSblocco() {
        int chi = autenticatori();
        // Before Android 11 the phone's PIN cannot back up a fingerprint in this prompt, and with no screen lock
        // at all there is nothing to check against: the phone itself is then the only protection.
        if (chi == 0 || Build.VERSION.SDK_INT < 30) { sblocca(); return; }
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) { sblocca(); }
        });
        prompt.authenticate(new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Bilancio")
                .setSubtitle("Sblocca per vedere i conti")
                .setAllowedAuthenticators(chi)
                .build());
    }

    @Override
    protected void onStop() {
        super.onStop();
        usciti = SystemClock.elapsedRealtime();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (!bloccato && usciti > 0 && SystemClock.elapsedRealtime() - usciti > BLOCCO_DOPO_MS) {
            bloccato = true;
            blocco.setVisibility(View.VISIBLE);
        }
        if (bloccato) blocco.post(this::chiediSblocco);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Back from the permission screen, or Syncthing may have brought new files while the app slept.
        if (web != null) web.evaluateJavascript("window.alRitorno && window.alRitorno()", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SCEGLI_FILE) {
            if (sceltaFile != null) sceltaFile.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            sceltaFile = null;
            return;
        }
        if (requestCode != Archivio.SCEGLI_CARTELLA || resultCode != RESULT_OK || data == null) return;
        Uri albero = data.getData();
        String percorso = albero == null ? null : Archivio.percorsoDa(albero);
        web.evaluateJavascript("window.cartellaScelta && window.cartellaScelta(" + JSONObject.quote(percorso == null ? "" : percorso) + ")", null);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The page closes its own sheets first; only when it has nothing open does back leave the app.
        web.evaluateJavascript("window.indietro ? window.indietro() : false", gestito -> {
            if (!"true".equals(gestito)) super.onBackPressed();
        });
    }
}
