{ bash, bun, lib, stdenvNoCC }:

let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenvNoCC.mkDerivation {
  pname = manifest.name;
  version = manifest.version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../src
      ../test
    ];
  };

  nativeBuildInputs = [ bun ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/pi-compression-proxy" "$out/bin"
    cp src/route-policy.ts src/router-extension.mjs "$out/share/pi-compression-proxy/"
    cat > "$out/bin/pi-compression-proxy" <<EOF
#!${bash}/bin/bash
exec pi --extension "$out/share/pi-compression-proxy/router-extension.mjs" "\$@"
EOF
    chmod +x "$out/bin/pi-compression-proxy"
    runHook postInstall
  '';

  meta = {
    description = "Pi client router for existing Headroom and Caveman proxies";
    mainProgram = "pi-compression-proxy";
    platforms = [ "x86_64-linux" ];
  };
}
