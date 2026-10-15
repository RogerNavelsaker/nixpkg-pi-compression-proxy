{
  description = "Client-side Pi router for existing Headroom and Caveman proxies";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      package = pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages.${system}.default = package;
      checks.${system}.default = package;
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ bun nixfmt ];
      };
    };
}
