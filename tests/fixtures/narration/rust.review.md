# rust-lang/rust review fixture

## Chapter 1, 2010-06 to 2012-01

title: Remove rustboot from the repository.

- c5 6997adf76 2011-05-14 Remove rustboot from the repository.
- c12 8b1504522 2011-08-09 Port the compiler to the ivec type [T] syntax.
- c28 24102d50a 2012-01-13 Obj system? What obj system?
- c29 bdb8f6cf5 2012-01-19 rustc: "tag" -> "enum"

## Chapter 2, 2012-01 to 2012-10

title: Move src/comp to src/rustc

- c2 87c14f1e3 2012-03-03 Move src/comp to src/rustc
- c8 106c9faa5 2012-03-29 rustc: Move ext to librustsyntax
- c23 33334f3c4 2012-07-05 Change 'iface' to 'trait' internally; parse `trait` as `iface` synonym
- c26 a26837c47 2012-09-04 rustc: "import" -> "use"

## Chapter 3, 2012-10 to 2014-01

title: Librarify rusti, etc.

- c2 84208b2d2 2012-11-05 Librarify rusti, etc.
- c4 56ece46f7 2012-12-04 librustc: Remove all legacy pattern bindings from libsyntax and librustc. rs=refactoring
- c11 b1c699815 2013-03-14 librustc: Don't accept `as Trait` anymore; fix all occurrences of it.
- c20 99b33f721 2013-07-17 librustc: Remove all uses of "copy".

## Chapter 4, 2014-01 to 2014-10

title: auto merge of #14638 : alexcrichton/rust/librustrt, r=brson

- c14 6266f64d0 2014-06-07 auto merge of #14638 : alexcrichton/rust/librustrt, r=brson
- c18 5b11610ce 2014-07-04 auto merge of #15343 : alexcrichton/rust/0.11.0-release, r=brson
- c21 84782c4e2 2014-08-06 auto merge of #16258 : aturon/rust/stabilize-atomics, r=alexcrichton
- c27 158eaa643 2014-10-09 Merge tag '0.12.0'

## Chapter 5, 2014-11 to 2018-04

title: Auto merge of #25350 - alexcrichton:msvc, r=brson

- c1 43cf733bf 2015-05-20 Auto merge of #25350 - alexcrichton:msvc, r=brson
- c5 fd688f407 2015-11-19 Auto merge of #29932 - steveklabnik:trpl_book, r=brson
- c10 7979dd608 2016-04-07 Auto merge of #32016 - nikomatsakis:incr-comp-save, r=mw
- c14 e7c822cee 2016-07-21 Auto merge of #34873 - alexcrichton:down-with-compiler-rt-for-good, r=brson

## Chapter 6, 2018-05 to 2018-10

title: Auto merge of #51131 - qnighy:unsized-locals, r=eddyb

- c5 bce32b532 2018-07-13 Auto merge of #51987 - nikomatsakis:nll-region-infer-scc, r=pnkfelix
- c6 a14a361c2 2018-07-13 Auto merge of #52266 - michaelwoerister:incr-thinlto-preliminaries, r=alexcrichton
- c18 b35590691 2018-08-19 Auto merge of #51131 - qnighy:unsized-locals, r=eddyb
- c28 de3d640f5 2018-10-01 Auto merge of #54667 - RalfJung:maybe-uninit, r=pnkfelix

## Chapter 7, 2018-11 to 2019-10

title: Auto merge of #59178 - oli-obk:lazy_const, r=eddyb

- c4 f6e9485bf 2018-11-17 Auto merge of #55627 - sunfishcode:cg-llvm-gen, r=nikomatsakis
- c12 070cebd0a 2019-03-17 Auto merge of #59178 - oli-obk:lazy_const, r=eddyb
- c24 5748825cc 2019-07-01 Auto merge of #61682 - Centril:stabilize-type_alias_enum_variants, r=petrochenkov
- c30 c6f87c2c6 2019-09-27 Auto merge of #64790 - Centril:rip-ast-borrowck, r=matthewjasper

## Chapter 8, 2019-11 to 2020-07

title: Auto merge of #70190 - pietroalbini:gha, r=Mark-Simulacrum

- c1 82cf3a448 2019-11-14 Auto merge of #66314 - GuillaumeGomez:move-error-codes, r=Centril
- c3 26286c7ad 2019-12-22 Auto merge of #66931 - cjgillot:hirene-preamble, r=eddyb
- c5 59c1db033 2020-01-12 Auto merge of #67901 - matthewjasper:split-mir-build, r=nagisa
- c12 2dcf54f56 2020-03-24 Auto merge of #70190 - pietroalbini:gha, r=Mark-Simulacrum

## Chapter 9, 2020-08 to 2022-12

title: Auto merge of #92816 - tmiasko:rm-llvm-asm, r=Amanieu

- c13 e655fb622 2021-03-16 Auto merge of #82936 - oli-obk:valtree, r=RalfJung,lcnr,matthewjasper
- c20 c78ebb7bd 2021-07-17 Auto merge of #87123 - RalfJung:miri-provenance-overhaul, r=oli-obk
- c21 521734787 2021-08-20 Auto merge of #87329 - sunfishcode:sunfishcode/io-safety, r=joshtriplett
- c25 a34c07975 2022-01-17 Auto merge of #92816 - tmiasko:rm-llvm-asm, r=Amanieu

## Chapter 10, 2023-01 to 2026-11

title: Auto merge of #116012 - cjgillot:gvn-const, r=oli-obk

- c4 98c33e47a 2023-05-02 Auto merge of #109128 - chenyukang:yukang/remove-type-ascription, r=estebank
- c14 8d76d0766 2023-12-30 Auto merge of #116012 - cjgillot:gvn-const, r=oli-obk
- c16 6cbf0926d 2024-03-01 Auto merge of #121728 - tgross35:f16-f128-step1-ty-updates, r=compiler-errors
- c19 351686bcf 2025-03-01 Auto merge of #137752 - flip1995:clippy-subtree-update, r=Manishearth
